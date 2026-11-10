// Below the mobile breakpoint a wide admin table stops working as a table: you
// scroll sideways hunting for the column you wanted. `cardify` turns any Semi
// column set into one that ALSO renders as a labelled card list on narrow
// screens — each <td> becomes a "Label: value" line via a data-label attribute
// that app.css exposes with ::before.
//
// It is a wrapper, not a rewrite: the desktop table is untouched, and pages opt
// in with one call. Columns whose title is a React node (icon headers, checkbox
// columns) get no label — there is no sensible string to show.
export function cardify(columns, opts = {}) {
  const { skip = [] } = opts;
  return columns.map((col) => {
    const label = typeof col.title === 'string' ? col.title : '';
    if (!label || skip.includes(col.dataIndex)) return col;
    const prev = col.onCell;
    return {
      ...col,
      onCell: (record, index) => ({
        ...(prev ? prev(record, index) : null),
        'data-label': label,
      }),
    };
  });
}

// Semi's `resizable` hands column.width straight to react-resizable, so a column
// we deliberately left widthless — the flexible one that soaks up leftover space —
// arrives as undefined and comes back NaN on the first drag, collapsing to zero.
// `sizable` fills a width in for those.
export function sizable(columns, fallback = 220) {
  return columns.map((col) => (col && col.width == null ? { ...col, width: fallback } : col));
}

// scroll.x has to equal the REAL sum of the widths (plus `extra` for the columns
// Semi adds itself: selection checkbox ~40, expand caret ~48). A scroll.x below
// the sum lets the last column slide under the one before it; above it, a
// phantom scrollbar. Dragging a column wider grows the sum, which is why the
// resizable tables need the scroll area at all.
export function sumWidth(columns, extra = 0) {
  return columns.reduce((n, c) => n + (Number(c && c.width) || 0), 0) + extra;
}

// One call for the three props a draggable-column table needs, so 20 call sites
// don't each carry their own width arithmetic:
//   <Table {...resizableTable(columns)} dataSource={...} />
// Anything passed AFTER the spread still wins, which is how a page keeps its own
// scroll.y or a hand-tuned scroll.x.
export function resizableTable(columns, opts = {}) {
  const { fallback = 220, extra = 0, skip = [] } = opts;
  const cols = sizable(columns, fallback);
  return { columns: cardify(cols, { skip }), resizable: true, scroll: { x: sumWidth(cols, extra) } };
}
