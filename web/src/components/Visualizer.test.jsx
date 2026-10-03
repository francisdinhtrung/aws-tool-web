import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Visualizer from './Visualizer.jsx';

const DATA = [
  { PK: { S: 'CUST#2' }, SK: { S: 'PROFILE' }, name: { S: 'Bob' } },
  { PK: { S: 'CUST#1' }, SK: { S: 'ORDER#101' }, total: { N: '10' }, GSI1PK: { S: 'ORDER#101' }, GSI1SK: { S: '2026-10-02' } },
  { PK: { S: 'CUST#1' }, SK: { S: 'ORDER#100' }, total: { N: '25' }, GSI1PK: { S: 'ORDER#100' }, GSI1SK: { S: '2026-10-01' } },
  { PK: { S: 'CUST#1' }, SK: { S: 'PROFILE' }, name: { S: 'Alice' } },
];
const GSIS = [{ IndexName: 'GSI1', KeyAttributes: { PartitionKey: { AttributeName: 'GSI1PK' }, SortKey: { AttributeName: 'GSI1SK' } } }];
const FACETS = [{ FacetName: 'Order', KeyAttributeAlias: { PartitionKeyAlias: 'CustomerId', SortKeyAlias: 'OrderId' }, NonKeyAttributes: ['total'] }];
const skCells = (c) => [...c.querySelectorAll('.viz-sk')].map((td) => td.textContent);

describe('<Visualizer>', () => {
  it('groups by partition key, sorts by sort key and colours by sort-key prefix', () => {
    const { container } = render(<Visualizer pk="PK" sk="SK" items={DATA} gsis={GSIS} facets={FACETS} />);
    expect([...container.querySelectorAll('.viz-pk')].map((td) => td.textContent)).toEqual(['CUST#1', 'CUST#2']);
    expect(skCells(container)).toEqual(['ORDER#100', 'ORDER#101', 'PROFILE', 'PROFILE']);
    expect(screen.getByText('2 partitions · 4 items')).toBeInTheDocument();
    expect([...container.querySelectorAll('.legend span')].map((s) => s.textContent)).toEqual(['ORDER', 'PROFILE']);
    expect(container.querySelector('.viz-sk').style.borderLeft).toContain('4px solid');
  });

  it('switches to a GSI view', () => {
    const { container } = render(<Visualizer pk="PK" sk="SK" items={DATA} gsis={GSIS} />);
    fireEvent.change(screen.getByDisplayValue('Table (aggregate view)'), { target: { value: 'GSI1' } });
    expect(screen.getByText('Partition key: GSI1PK')).toBeInTheDocument();
    expect(skCells(container)).toEqual(['2026-10-01', '2026-10-02']);
    expect(screen.getByText('2 partitions · 2 items')).toBeInTheDocument();
  });

  it('applies facet aliases and attribute filter', () => {
    const { container } = render(<Visualizer pk="PK" sk="SK" items={DATA} facets={FACETS} />);
    fireEvent.change(screen.getByDisplayValue('All facets'), { target: { value: 'Order' } });
    expect(screen.getByText('Partition key: CustomerId')).toBeInTheDocument();
    expect(screen.getByText('Sort key: OrderId')).toBeInTheDocument();
    expect(skCells(container)).toEqual(['ORDER#100', 'ORDER#101']);
    expect([...container.querySelectorAll('.viz-attr-name')].map((n) => n.textContent)).toEqual(['total', 'total']);
  });

  it('supports other colouring modes', () => {
    const { container } = render(<Visualizer pk="PK" sk="SK" items={DATA} />);
    const sel = screen.getByDisplayValue('Sort key prefix');
    fireEvent.change(sel, { target: { value: 'pkprefix' } });
    expect([...container.querySelectorAll('.legend span')].map((s) => s.textContent)).toEqual(['CUST']);
    fireEvent.change(sel, { target: { value: 'name' } });
    expect([...container.querySelectorAll('.legend span')].map((s) => s.textContent)).toEqual(['(none)', 'Alice', 'Bob']);
    fireEvent.change(sel, { target: { value: 'none' } });
    expect(container.querySelector('.legend')).toBeNull();
    expect(container.querySelector('.viz-sk').style.borderLeft).toBe('');
  });

  it('defaults colouring to a type attribute when present', () => {
    render(<Visualizer pk="PK" sk="SK" items={[{ PK: { S: 'a' }, SK: { S: 'b' }, type: { S: 'User' } }]} />);
    expect(screen.getByDisplayValue('Attribute: type')).toBeInTheDocument();
    expect(screen.getAllByText('User').length).toBeGreaterThan(0);
  });

  it('handles tables without a sort key, numeric sort keys and items without attributes', () => {
    const { container, rerender } = render(<Visualizer pk="id" items={[{ id: { S: 'x' } }, { id: { S: 'x' } }]} />);
    expect(screen.queryByText(/Sort key:/)).toBeNull();
    expect(screen.getAllByText('—')).toHaveLength(2);
    rerender(<Visualizer pk="p" sk="n" items={[{ p: { S: 'a' }, n: { N: '10' } }, { p: { S: 'a' }, n: { N: '9' } }]} />);
    expect(skCells(container)).toEqual(['9', '10']);
  });

  it('shows empty states and respects maxRows', () => {
    const { rerender } = render(<Visualizer pk="PK" sk="SK" items={[]} />);
    expect(screen.getByText(/No items/)).toBeInTheDocument();
    rerender(<Visualizer pk="PK" sk="SK" items={[{ SK: { S: 'x' } }]} gsis={GSIS} />);
    fireEvent.change(screen.getByDisplayValue('Table (aggregate view)'), { target: { value: 'GSI1' } });
    expect(screen.getByText('No items projected into this index')).toBeInTheDocument();
    rerender(<Visualizer pk="PK" sk="SK" items={DATA} maxRows={1} />);
    expect(screen.getByText('1 partitions · 1 items')).toBeInTheDocument();
  });

  it('hides the legend when there are too many groups', () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ PK: { S: 'p' }, SK: { S: `T${i}#x` } }));
    const { container } = render(<Visualizer pk="PK" sk="SK" items={many} />);
    expect(container.querySelector('.legend')).toBeNull();
  });
});
