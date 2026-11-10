import { useRef } from 'react';

// Page-size tiers for every admin table (handoff rule 3: 10/20/50/100/500/1000).
// Shared rather than repeated per page so the choice stays consistent — HR moves
// between the roster, results and audit and expects the same control.
//
// The top two tiers are deliberate: at DigiPlus scale a department review or an
// export check means paging through thousands of rows, and 100-at-a-time is the
// slow part. They are also the reason `confirmHeavyPage` exists — rendering
// 500+ Semi table rows in one pass is visibly slow on a mid-range laptop, so the
// caller can warn instead of appearing to hang.
export const PAGE_TIERS = [10, 20, 50, 100, 500, 1000];

// Default page size by table weight: light rows (few columns, no controls) can
// afford more per page than heavy ones (inline selects, progress bars).
export const DEFAULT_PAGE = 20;
export const DEFAULT_PAGE_WIDE = 50;   // calibration / results — HR scans long lists
export const DEFAULT_PAGE_LOG = 100;   // audit log — dense, read-only rows

// 整页编辑器把列表表格卸载后再回来、或保存后列表重载时，Semi 会回到第 1 页。
// 列表数据每换一份版本号 +1：表格以它为 key 重挂，再用记住的页码（clampPage 夹到有效范围）、排序复原。
export function useDataVersion(data) {
  const ref = useRef({ data: undefined, n: 0 });
  if (ref.current.data !== data) ref.current = { data, n: ref.current.n + 1 };
  return ref.current.n;
}
export const clampPage = (page, total, size) => Math.min(Math.max(1, page || 1), Math.max(1, Math.ceil((total || 0) / (size || 1))));
