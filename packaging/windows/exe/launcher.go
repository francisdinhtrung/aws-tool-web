package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

//go:embed payload.zip
var payload []byte

const listeningPrefix = "AWS Tool Web listening on "

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := launch(ctx); err != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, "AWS Tool Web:", err)
		if info, statErr := os.Stdin.Stat(); statErr == nil && info.Mode()&os.ModeCharDevice != 0 {
			fmt.Fprint(os.Stderr, "Press Enter to close this window.")
			_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		}
		os.Exit(1)
	}
}

func launch(ctx context.Context) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate the executable: %w", err)
	}
	dir := filepath.Dir(executable)
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	if !filepath.IsAbs(dataDir) {
		dataDir = filepath.Join(dir, dataDir)
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return fmt.Errorf("create the data folder %q: %w", dataDir, err)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	workDir, err := os.MkdirTemp("", "aws-tool-web-")
	if err != nil {
		return fmt.Errorf("create the temporary runtime folder: %w", err)
	}
	defer os.RemoveAll(workDir)
	fmt.Println("Preparing AWS Tool Web. Close this window or press Ctrl+C to stop it.")
	if err := unpack(ctx, workDir); err != nil {
		return fmt.Errorf("unpack the bundled runtime: %w", err)
	}

	cmd := exec.CommandContext(ctx, filepath.Join(workDir, "runtime", "node.exe"), filepath.Join(workDir, "app", "server", "src", "index.js"))
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"HOST=127.0.0.1", "PORT="+port, "DATA_DIR="+dataDir, "NODE_ENV=production",
		"STATIC_DIR="+filepath.Join(workDir, "app", "web", "dist"),
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start the bundled Node.js runtime: %w", err)
	}
	// Relay through a child pipe so Node also works when the launcher's output is redirected.
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		_, _ = io.Copy(os.Stderr, stderr)
	}()
	started := false
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Println(line)
		if address, ok := strings.CutPrefix(line, listeningPrefix); ok && !started && ctx.Err() == nil {
			started = true
			if err := openBrowser(address); err != nil {
				fmt.Fprintln(os.Stderr, "Open this address in your browser:", address)
			}
		}
	}
	scanErr := scanner.Err()
	if scanErr != nil {
		_ = stdout.Close()
		_ = cmd.Process.Kill()
	}
	<-stderrDone
	waitErr := cmd.Wait()
	if scanErr != nil {
		return fmt.Errorf("read server output: %w", scanErr)
	}
	if waitErr != nil {
		if !started {
			return fmt.Errorf("server could not start on port %s. If the port is busy, close the other app or set PORT: %w", port, waitErr)
		}
		return fmt.Errorf("server stopped: %w", waitErr)
	}
	return nil
}

func unpack(ctx context.Context, dir string) error {
	archive, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return err
	}
	for _, entry := range archive.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		name, err := filepath.Localize(strings.TrimSuffix(entry.Name, "/"))
		if err != nil {
			return fmt.Errorf("invalid archive entry %q: %w", entry.Name, err)
		}
		dest := filepath.Join(dir, name)
		if entry.FileInfo().IsDir() {
			err = os.MkdirAll(dest, 0700)
		} else {
			err = unpackFile(entry, dest)
		}
		if err != nil {
			return fmt.Errorf("extract %q: %w", entry.Name, err)
		}
	}
	return nil
}

func unpackFile(entry *zip.File, dest string) error {
	if !entry.Mode().IsRegular() {
		return fmt.Errorf("expected a regular file")
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return err
	}
	source, err := entry.Open()
	if err != nil {
		return err
	}
	defer source.Close()
	file, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(file, source)
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
