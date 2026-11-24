export function pageInfo(total, page, size = 50) {
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  return { page: safePage, pages, start: total ? safePage * size + 1 : 0, end: Math.min(total, (safePage + 1) * size), total };
}
