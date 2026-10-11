export const LIST_PAGE_SIZE = 5;

export function getListPage<T>(records: readonly T[], requestedPage: number): {
  records: T[];
  page: number;
  totalPages: number;
  totalRecords: number;
  start: number;
  end: number;
} {
  const totalRecords = records.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / LIST_PAGE_SIZE));
  const requestedInteger = Number.isNaN(requestedPage) ? 1 : Math.floor(requestedPage);
  const page = Math.min(totalPages, Math.max(1, requestedInteger));
  const offset = (page - 1) * LIST_PAGE_SIZE;

  return {
    records: records.slice(offset, offset + LIST_PAGE_SIZE),
    page,
    totalPages,
    totalRecords,
    start: totalRecords ? offset + 1 : 0,
    end: Math.min(offset + LIST_PAGE_SIZE, totalRecords),
  };
}
