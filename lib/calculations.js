// lib/calculations.js

export function calculateStockAndSales(openingStock, physicalStock, actualSales, adjustedSystemSales) {
  // G = Gross stock loss (Opening - Physical)
  const grossStockVariance = openingStock - physicalStock;
  
  // Positive stock shortage (only if variance > 0)
  const grossStockShortage = Math.max(grossStockVariance, 0);
  
  // V = Adjusted Sales Variance (Actual - System)
  const salesVariance = actualSales - adjustedSystemSales;
  
  // Positive sales variance available for offset (only if variance > 0)
  const positiveSalesVariance = Math.max(salesVariance, 0);
  
  // Offset amount cannot exceed either the shortage or the positive variance
  const salesOffset = Math.min(grossStockShortage, positiveSalesVariance);
  
  // Residual stock loss = MAX(G - MAX(V, 0), 0)
  const residualStockLoss = Math.max(grossStockShortage - positiveSalesVariance, 0);
  
  // Remaining positive sales surplus = MAX(V - MAX(G, 0), 0)
  const remainingSalesSurplus = Math.max(positiveSalesVariance - grossStockShortage, 0);

  return {
    grossStockVariance,
    grossStockShortage,
    salesVariance,
    positiveSalesVariance,
    salesOffset,
    residualStockLoss,
    remainingSalesSurplus
  };
}

export function calculateDebt(openingDebt, originalClosingDebt, residualStockLoss, approvedAdjustments = 0) {
  // Gross debt reduction = Opening - Original Closing
  const grossDebtReduction = openingDebt - originalClosingDebt;
  
  // Adjusted closing debt = Original Closing + Residual Stock Loss + Other Adjustments
  const adjustedClosingDebt = originalClosingDebt + residualStockLoss + approvedAdjustments;
  
  // Net debt reduction = Opening - Adjusted Closing
  const netDebtReduction = openingDebt - adjustedClosingDebt;
  
  // Debt reduction percentage
  const debtReductionPercentage = openingDebt > 0 ? (netDebtReduction / openingDebt) * 100 : null;

  return {
    grossDebtReduction,
    adjustedClosingDebt,
    netDebtReduction,
    debtReductionPercentage
  };
}

export function calculateCreditSales(systemSalesIncludingCredit, creditSalesAmount) {
  // Adjusted system sales = System sales - Credit sales
  return systemSalesIncludingCredit - creditSalesAmount;
}
