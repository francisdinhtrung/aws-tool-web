import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import {
  Modal, Tabs, Field, Select, Spinner, ErrorBox, Empty, CodeBlock, JsonArea, Progress, copyText, download, readFileText, FileButton,
  ToastProvider, useToast, nextId, useLocalStorage,
} from './ui.jsx';

afterEach(() => vi.useRealTimers());

describe('basic components', () => {
  it('Modal closes on backdrop mousedown and Escape, not on inner clicks', () => {
    const onClose = vi.fn();
    const { container } = render(<Modal title="T" onClose={onClose} footer={<b>foot</b>}>body</Modal>);
    expect(screen.getByRole('dialog', { name: 'T' })).toHaveClass('modal-md');
    expect(screen.getByText('foot')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('body'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.querySelector('.modal-backdrop'));
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Modal without onClose ignores events', () => {
    const { container } = render(<Modal title="T" size="lg">x</Modal>);
    fireEvent.mouseDown(container.querySelector('.modal-backdrop'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toHaveClass('modal-lg');
  });

  it('Tabs mark the active tab', () => {
    const onChange = vi.fn();
    const { container } = render(<Tabs tabs={[['a', 'A'], ['b', 'B']]} value="a" onChange={onChange} small />);
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'true');
    expect(container.firstChild).toHaveClass('tabs-sm');
    fireEvent.click(screen.getByText('B'));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('Field, Select, Spinner, Empty, ErrorBox', () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <>
        <Field label="L" hint="H" inline><input /></Field>
        <Field><input placeholder="nolabel" /></Field>
        <Select value={undefined} onChange={onChange} options={['x', ['y', 'Why']]} aria-label="sel" />
        <Spinner />
        <Empty>nothing</Empty>
        <ErrorBox error="oops" onClose={onClose} />
        <ErrorBox error={new Error('err obj')} />
        <ErrorBox error={null} />
      </>,
    );
    expect(screen.getByText('L').parentElement).toHaveClass('field-inline');
    expect(screen.getByText('H')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('sel'), { target: { value: 'y' } });
    expect(onChange).toHaveBeenCalledWith('y');
    expect(screen.getByText('Why')).toBeInTheDocument();
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    expect(screen.getByText('nothing')).toBeInTheDocument();
    expect(screen.getByText('err obj')).toBeInTheDocument();
    fireEvent.click(screen.getByText('×'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Progress shows determinate and indeterminate states', () => {
    const { container, rerender } = render(<Progress value={1} max={4} />);
    expect(screen.getByText('1 / 4 (25%)')).toBeInTheDocument();
    expect(container.querySelector('.progress > div').style.width).toBe('25%');
    rerender(<Progress value={7} label="Scanning" />);
    expect(screen.getByText('Scanning')).toBeInTheDocument();
    expect(container.querySelector('.progress > div')).toHaveClass('indeterminate');
    rerender(<Progress value={7} />);
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('JsonArea indents with Tab and is read-only aware', () => {
    const onChange = vi.fn();
    const { rerender } = render(<JsonArea value="ab" onChange={onChange} />);
    const ta = screen.getByRole('textbox');
    ta.setSelectionRange(1, 1);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(onChange).toHaveBeenCalledWith('a  b');
    fireEvent.keyDown(ta, { key: 'a' });
    fireEvent.change(ta, { target: { value: 'x' } });
    expect(onChange).toHaveBeenLastCalledWith('x');
    rerender(<JsonArea value="ro" readOnly />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'y' } });
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('clipboard, download and files', () => {
  it('copyText uses the clipboard API, falling back to execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await copyText('hi');
    expect(writeText).toHaveBeenCalledWith('hi');

    writeText.mockRejectedValue(new Error('denied'));
    document.execCommand = vi.fn();
    await copyText('fallback');
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('CodeBlock copies and toasts', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ToastProvider><CodeBlock code="print(1)" maxHeight="10px" /></ToastProvider>);
    expect(screen.getByText('print(1)')).toHaveStyle({ maxHeight: '10px' });
    fireEvent.click(screen.getByText('Copy'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('download creates and revokes an object URL', () => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    download('a.json', '{}');
    expect(click).toHaveBeenCalled();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });

  it('readFileText resolves contents and rejects on error', async () => {
    expect(await readFileText(new File(['hello'], 'a.txt'))).toBe('hello');
    const orig = FileReader.prototype.readAsText;
    FileReader.prototype.readAsText = function () {
      Object.defineProperty(this, 'error', { value: new Error('read fail') });
      this.onerror();
    };
    await expect(readFileText(new File(['x'], 'b.txt'))).rejects.toThrow('read fail');
    FileReader.prototype.readAsText = orig;
  });

  it('FileButton opens the picker and reports the chosen file', () => {
    const onFile = vi.fn();
    const { container } = render(<FileButton accept=".json" onFile={onFile}>Pick</FileButton>);
    const input = container.querySelector('input[type=file]');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByText('Pick'));
    expect(click).toHaveBeenCalled();
    const file = new File(['{}'], 'm.json');
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
    fireEvent.change(input, { target: { files: [] } });
    expect(onFile).toHaveBeenCalledTimes(1);
  });
});

describe('toasts, ids and local storage', () => {
  it('shows toasts, expires them and dismisses on click', () => {
    vi.useFakeTimers();
    function Btn() {
      const toast = useToast();
      return (
        <>
          <button onClick={() => toast('saved')}>ok</button>
          <button onClick={() => toast('broken', 'error')}>err</button>
        </>
      );
    }
    render(<ToastProvider><Btn /></ToastProvider>);
    fireEvent.click(screen.getByText('ok'));
    fireEvent.click(screen.getByText('err'));
    expect(screen.getByText('broken')).toHaveClass('toast-error');
    act(() => vi.advanceTimersByTime(3100));
    expect(screen.queryByText('saved')).toBeNull();
    fireEvent.click(screen.getByText('broken'));
    expect(screen.queryByText('broken')).toBeNull();
    act(() => vi.advanceTimersByTime(8000));
  });

  it('useToast outside a provider is a no-op', () => {
    const { result } = renderHook(() => useToast());
    expect(() => result.current('x')).not.toThrow();
  });

  it('nextId is unique', () => {
    expect(nextId()).not.toBe(nextId());
  });

  it('useLocalStorage persists and survives bad data / storage errors', () => {
    const { result } = renderHook(() => useLocalStorage('k', 1));
    expect(result.current[0]).toBe(1);
    act(() => result.current[1](5));
    expect(localStorage.getItem('k')).toBe('5');
    expect(renderHook(() => useLocalStorage('k', 1)).result.current[0]).toBe(5);

    localStorage.setItem('bad', '{oops');
    expect(renderHook(() => useLocalStorage('bad', 'fallback')).result.current[0]).toBe('fallback');

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const h = renderHook(() => useLocalStorage('q', 0));
    expect(() => act(() => h.result.current[1](1))).not.toThrow();
    expect(h.result.current[0]).toBe(1);
  });
});
