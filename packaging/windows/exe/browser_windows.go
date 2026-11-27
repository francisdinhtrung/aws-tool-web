package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

func openBrowser(address string) error {
	verb, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	url, err := syscall.UTF16PtrFromString(address)
	if err != nil {
		return err
	}
	proc := syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
	result, _, _ := proc.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(url)), 0, 0, 1)
	if result <= 32 {
		return fmt.Errorf("Windows could not open the default browser (code %d)", result)
	}
	return nil
}
