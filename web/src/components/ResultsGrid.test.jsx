import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ResultsGrid from './ResultsGrid.jsx';

const ITEMS = [
  { pk: { S: 'b' }, n: { N: '10' }, flag: { BOOL: true } },
  { pk: { S: 'a' }, n: { N: '9' } },
  { pk: { S: 'c' }, n: { N: '100' }, m: { M: { x: { S: 'y' } } } },
];
const firstColumn = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);

describe('<ResultsGrid>', () => {
  it('shows an empty state', () => {
    render(<ResultsGrid items={[]} />);
    expect(screen.getByText('No items')).toBeInTheDocument();
  });

  it('renders typed cells with key columns first', () => {
    render(<ResultsGrid items={ITEMS} keyNames={['pk']} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['pk', 'flag', 'm', 'n']);
    expect(screen.getByText('{"x":"y"}').closest('td')).toHaveClass('t-M');
    expect(screen.getByText('true').closest('td')).toHaveAttribute('title', 'BOOL: true');
  });

  it('sorts numerically and lexically, cycling asc → desc → none', () => {
    render(<ResultsGrid items={ITEMS} keyNames={['pk']} />);
    const nHead = screen.getByText('n');
    fireEvent.click(nHead);
    expect(firstColumn()).toEqual(['a', 'b', 'c']);
    expect(nHead.textContent).toBe('n ▲');
    fireEvent.click(nHead);
    expect(firstColumn()).toEqual(['c', 'b', 'a']);
    fireEvent.click(nHead);
    expect(firstColumn()).toEqual(['b', 'a', 'c']);
    // missing values sort last in both directions
    fireEvent.click(screen.getByText('flag'));
    expect(firstColumn()[0]).toBe('b');
    fireEvent.click(screen.getByText('flag ▲'));
    expect(firstColumn()[0]).toBe('b');
    fireEvent.click(screen.getByText('pk'));
    expect(firstColumn()).toEqual(['a', 'b', 'c']);
    fireEvent.click(screen.getByText('n'));
    fireEvent.click(screen.getByText('n ▲'));
    expect(firstColumn()).toEqual(['c', 'b', 'a']);
  });

  it('sorts equal values stably', () => {
    render(<ResultsGrid items={[{ pk: { S: 'x' }, v: { S: 'same' } }, { pk: { S: 'y' }, v: { S: 'same' } }]} keyNames={['pk']} />);
    fireEvent.click(screen.getByText('v'));
    expect(firstColumn()).toEqual(['x', 'y']);
  });

  it('supports selection, select-all, open and row actions', () => {
    const onOpen = vi.fn();
    function Harness() {
      const [sel, setSel] = useState(new Set());
      Harness.sel = sel;
      return <ResultsGrid items={ITEMS} keyNames={['pk']} selected={sel} onSelect={setSel} onOpen={onOpen} onRowAction={(it) => <button>act-{it.pk.S}</button>} />;
    }
    render(<Harness />);
    const checks = screen.getAllByRole('checkbox');
    fireEvent.click(checks[1]);
    expect(Harness.sel.size).toBe(1);
    expect(checks[1].closest('tr')).toHaveClass('selected');
    fireEvent.click(checks[1]);
    expect(Harness.sel.size).toBe(0);
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(Harness.sel.size).toBe(3);
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(Harness.sel.size).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'a' }));
    expect(onOpen).toHaveBeenCalledWith(ITEMS[1]);
    fireEvent.doubleClick(screen.getByText('100'));
    expect(onOpen).toHaveBeenCalledWith(ITEMS[2]);
    expect(screen.getByText('act-c')).toBeInTheDocument();
  });

  it('shows a dash for a missing first-column value when rows are openable', () => {
    render(<ResultsGrid items={[{ pk: { S: 'a' } }, { other: { S: 'x' } }]} keyNames={['pk']} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: '—' })).toBeInTheDocument();
  });

  it('renders JSON views', () => {
    const { rerender, container } = render(<ResultsGrid items={ITEMS.slice(0, 1)} view="json" />);
    expect(JSON.parse(container.querySelector('pre').textContent)).toEqual([{ pk: 'b', n: 10, flag: true }]);
    rerender(<ResultsGrid items={ITEMS.slice(0, 1)} view="ddbjson" />);
    expect(JSON.parse(container.querySelector('pre').textContent)).toEqual([ITEMS[0]]);
  });

  it('honours explicit firstCols', () => {
    render(<ResultsGrid items={ITEMS} keyNames={['pk']} firstCols={['n', 'pk']} />);
    expect(screen.getAllByRole('columnheader')[0].textContent).toBe('n');
  });
});
