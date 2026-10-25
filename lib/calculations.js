export function calculateStockAndSales(openingStock, physicalStock, actualSales, adjustedSystemSales) {
  // 1. Stock Variance
  const grossStockVariance = openingStock - physicalStock;
  const grossStockShortage = Math.max(grossStockVariance, 0); // Only positive shortage can be offset
  const stockVariancePercentage = openingStock > 0 ? (grossStockVariance / openingStock) * 100 : null;

  // 2. Sales Variance
  const salesVariance = actualSales - adjustedSystemSales;
  const positiveSalesVariance = Math.max(salesVariance, 0); // Only positive variance can offset
  const salesVariancePercentage = adjustedSystemSales > 0 ? (salesVariance / adjustedSystemSales) * 100 : null;

  // 3. Reconciliation (Offset)
  // The offset cannot exceed the stock shortage OR the available positive sales variance
  const salesOffset = Math.min(grossStockShortage, positiveSalesVariance);
  
  // What is left after the offset?
  const residualStockLoss = Math.max(grossStockShortage - positiveSalesVariance, 0);
  const remainingSalesSurplus = Math.max(positiveSalesVariance - grossStockShortage, 0);

  return {
    grossStockVariance,
    grossStockShortage,
    stockVariancePercentage,
    salesVariance,
    salesVariancePercentage,
    positiveSalesVariance,
    salesOffset,
    residualStockLoss,
    remainingSalesSurplus
  };
}

export function calculateDebt(openingDebt, originalClosingDebt, residualStockLoss, approvedAdjustments = 0) {
  const grossDebtReduction = openingDebt - originalClosingDebt;
  const adjustedClosingDebt = originalClosingDebt + residualStockLoss + approvedAdjustments;
  const netDebtReduction = openingDebt - adjustedClosingDebt;
  const debtReductionPercentage = openingDebt > 0 ? (netDebtReduction / openingDebt) * 100 : null;

  return {
    grossDebtReduction,
    adjustedClosingDebt,
    netDebtReduction,
    debtReductionPercentage
  };
}
