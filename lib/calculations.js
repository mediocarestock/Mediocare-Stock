// lib/calculations.js

export function calculateStockAndSales(openingStock, physicalStock, actualSales, adjustedSystemSales) {
  const grossStockVariance = openingStock - physicalStock;
  const grossStockShortage = Math.max(grossStockVariance, 0);
  
  // Calculate Stock Variance Percentage
  const stockVariancePercentage = openingStock > 0 ? (grossStockVariance / openingStock) * 100 : null;

  const salesVariance = actualSales - adjustedSystemSales;
  const positiveSalesVariance = Math.max(salesVariance, 0);
  
  // Calculate Sales Variance Percentage
  const salesVariancePercentage = adjustedSystemSales > 0 ? (salesVariance / adjustedSystemSales) * 100 : null;

  const salesOffset = Math.min(grossStockShortage, positiveSalesVariance);
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
