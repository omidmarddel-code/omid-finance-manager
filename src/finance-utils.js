const installmentMonths = (item) =>
  Math.max(0, Math.trunc(Number(item.months) || 0));

const installmentPaidCount = (item) =>
  Math.min(
    installmentMonths(item),
    Math.max(0, Math.trunc(Number(item.paid_count) || 0)),
  );

const installmentBalance = (item) =>
  Math.max(
    0,
    Number(item.total_amount) -
      Number(item.monthly_amount) * installmentPaidCount(item),
  );

const installmentDueAmount = (item, offset) =>
  Math.max(
    0,
    Math.min(
      Number(item.monthly_amount),
      Number(item.total_amount) - Number(item.monthly_amount) * offset,
    ),
  );

export {
  installmentMonths,
  installmentPaidCount,
  installmentBalance,
  installmentDueAmount,
};
