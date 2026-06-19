export const formatCurrency = (amount: number | string): string => {
  const numberAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
  
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(numberAmount);
};

export const getPeriodFilter = (period: string): string => {
  if (period === 'mes') return "e.created_at >= date_trunc('month', CURRENT_DATE)";
  if (period === 'sem') return "e.created_at >= CURRENT_DATE - INTERVAL '7 days'";
  return "1=1";
};