'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { calculateStockAndSales, calculateDebt } from '../lib/calculations';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export default function Home() {
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Core Financials
  const [openingStock, setOpeningStock] = useState('');
  const [physicalStock, setPhysicalStock] = useState('');
  const [openingDebt, setOpeningDebt] = useState('');
  const [originalClosingDebt, setOriginalClosingDebt] = useState('');
  const [unallocatedActual, setUnallocatedActual] = useState('');
  const [unallocatedSystem, setUnallocatedSystem] = useState('');
  const [unallocatedCredit, setUnallocatedCredit] = useState('');

  // Dates
  const today = new Date().toISOString().split('T')[0];
  const [periodStart, setPeriodStart] = useState(today);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [openingDebtDate, setOpeningDebtDate] = useState(today);
  const [closingDebtDate, setClosingDebtDate] = useState(today);

  // Salespeople
  const [staff, setStaff] = useState([{ name: 'Austin', actual: '', system: '', credit: '' }]);

  useEffect(() => {
    async function getBranches() {
      const { data } = await supabase.from('branches').select('*').order('name');
      if (data) setBranches(data);
    }
    getBranches();
  }, []);

  const num = (val) => parseFloat(val) || 0;

  // Aggregate Sales
  const totalActual = staff.reduce((sum, s) => sum + num(s.actual), 0) + num(unallocatedActual);
  const totalSystem = staff.reduce((sum, s) => sum + num(s.system), 0) + num(unallocatedSystem);
  const totalCredit = staff.reduce((sum, s) => sum + num(s.credit), 0) + num(unallocatedCredit);
  
  const adjustedSystemSales = totalSystem - totalCredit;

  const stockAndSalesResults = calculateStockAndSales(
    num(openingStock), num(physicalStock), totalActual, adjustedSystemSales
  );
  
  const debtResults = calculateDebt(
    num(openingDebt), num(originalClosingDebt), stockAndSalesResults.residualStockLoss
  );

  const formatKsh = (amount) => new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  const formatNum = (amount) => new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 }).format(amount);
  const branchName = branches.find(b => b.id === selectedBranch)?.name || '';

  const handleStaffChange = (index, field, value) => {
    const newStaff = [...staff];
    newStaff[index][field] = value;
    setStaff(newStaff);
  };

  const addStaff = () => setStaff([...staff, { name: '', actual: '', system: '', credit: '' }]);
  const removeStaff = (index) => setStaff(staff.filter((_, i) => i !== index));

  // --- PROFESSIONAL PDF CHART ENGINE ---
  const drawBarChart = (doc, startX, startY, width, height, data, title) => {
    // 1. Determine min/max to handle negative variances
    let maxVal = 0;
    let minVal = 0;
    data.forEach(d => {
      if (d.val1 > maxVal) maxVal = d.val1;
      if (d.val1 < minVal) minVal = d.val1;
      if (d.val2 > maxVal) maxVal = d.val2;
      if (d.val2 < minVal) minVal = d.val2;
    });
    
    // Add 10% padding to top and bottom
    const range = Math.max(maxVal - minVal, 1);
    maxVal += range * 0.15;
    minVal -= range * 0.15;

    const zeroLineY = startY + height - ((0 - minVal) / (maxVal - minVal)) * height;

    // Title
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(title, startX + width / 2, startY - 5, { align: 'center' });

    // Axes
    doc.setDrawColor(150);
    doc.setLineWidth(0.5);
    doc.line(startX, startY, startX, startY + height); // Y-axis
    doc.line(startX, zeroLineY, startX + width, zeroLineY); // X-axis (at zero)

    // Y-axis Labels
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100);
    doc.text(formatNum(maxVal), startX - 2, startY + 4, { align: 'right' });
    doc.text('0', startX - 2, zeroLineY + 2, { align: 'right' });
    if (minVal < 0) doc.text(formatNum(minVal), startX - 2, startY + height, { align: 'right' });

    // Draw Bars
    const barGroupWidth = width / data.length;
    const barWidth = (barGroupWidth * 0.7) / 2;
    
    data.forEach((d, i) => {
      const groupX = startX + (i * barGroupWidth) + (barGroupWidth * 0.15);
      
      // Bar 1
      const h1 = ((d.val1 - 0) / (maxVal - minVal)) * height;
      const y1 = zeroLineY - h1;
      doc.setFillColor(41, 128, 185); // Blue
      doc.rect(groupX, h1 > 0 ? y1 : zeroLineY, barWidth, Math.abs(h1), 'F');
      
      // Bar 2
      const h2 = ((d.val2 - 0) / (maxVal - minVal)) * height;
      const y2 = zeroLineY - h2;
      doc.setFillColor(211, 84, 0); // Orange
      doc.rect(groupX + barWidth + 1, h2 > 0 ? y2 : zeroLineY, barWidth, Math.abs(h2), 'F');

      // Value Labels (on top of bars)
      doc.setFontSize(6);
      doc.setTextColor(0);
      if (d.val1 !== 0) doc.text(formatNum(d.val1), groupX + (barWidth/2), y1 - 2, { align: 'center' });
      if (d.val2 !== 0) doc.text(formatNum(d.val2), groupX + barWidth + 1 + (barWidth/2), y2 - 2, { align: 'center' });

      // X-axis Label
      doc.setFontSize(7);
      doc.text(d.label.substring(0, 6), groupX + barWidth, startY + height + 4, { align: 'center' });
    });

    // Legend
    doc.setFillColor(41, 128, 185);
    doc.rect(startX + width - 50, startY - 10, 4, 4, 'F');
    doc.setFontSize(7);
    doc.setTextColor(0);
    doc.text('Actual', startX + width - 44, startY - 7);
    
    doc.setFillColor(211, 84, 0);
    doc.rect(startX + width - 25, startY - 10, 4, 4, 'F');
    doc.text('System', startX + width - 19, startY - 7);
  };

  // --- SMART NARRATIVE GENERATOR ---
  const generateNarrative = () => {
    let text = [];
    
    // Sales
    if (stockAndSalesResults.salesVariance > 0) {
      text.push(`Positive sales variance of Ksh ${formatKsh(stockAndSalesResults.salesVariance)} indicates cash sales exceeding system records (unrecorded cash/timing).`);
    } else if (stockAndSalesResults.salesVariance < 0) {
      text.push(`Negative sales variance of Ksh ${formatKsh(Math.abs(stockAndSalesResults.salesVariance))} indicates system sales exceeded actual cash collected, which may signal uncollected credit or posting errors.`);
    } else {
      text.push(`Sales are perfectly reconciled with no variance.`);
    }

    // Stock
    if (stockAndSalesResults.grossStockVariance > 0) {
      text.push(`Stock take revealed a shortage of Ksh ${formatKsh(stockAndSalesResults.grossStockVariance)} (${stockAndSalesResults.stockVariancePercentage?.toFixed(2)}% of opening stock).`);
    } else if (stockAndSalesResults.grossStockVariance < 0) {
      text.push(`Physical stock exceeded book value by Ksh ${formatKsh(Math.abs(stockAndSalesResults.grossStockVariance))} (Stock Surplus).`);
    }

    // Reconciliation
    if (stockAndSalesResults.grossStockShortage > 0 && stockAndSalesResults.positiveSalesVariance > 0) {
      text.push(`The positive sales variance was applied to offset the stock shortage, leaving a residual stock loss of Ksh ${formatKsh(stockAndSalesResults.residualStockLoss)}.`);
    }

    // Debt
    if (debtResults.netDebtReduction > 0) {
      text.push(`Debt reduced by Ksh ${formatKsh(debtResults.netDebtReduction)} (${debtResults.debtReductionPercentage?.toFixed(2)}%) to Ksh ${formatKsh(debtResults.adjustedClosingDebt)}.`);
    } else if (debtResults.netDebtReduction < 0) {
      text.push(`ADVERSE: Debt increased by Ksh ${formatKsh(Math.abs(debtResults.netDebtReduction))}. Credit control and collections require immediate review.`);
    }

    return text;
  };

  // --- PDF GENERATION ---
  const generatePDF = () => {
    if (!selectedBranch) return alert('Please select a branch first.');
    
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    // HEADER
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('MEDIOCARE PHARMACEUTICALS LTD', pageWidth / 2, 20, { align: 'center' });
    doc.setFontSize(12);
    doc.text(`${branchName.toUpperCase()} — STOCK CONTROL & FINANCIAL REPORT`, pageWidth / 2, 28, { align: 'center' });
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Period: ${periodStart} to ${periodEnd} | Currency: KES`, pageWidth / 2, 34, { align: 'center' });

    // 1. EXECUTIVE SUMMARY
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('1. Executive Summary', 14, 45);
    
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    let summaryY = 52;
    const narratives = generateNarrative();
    narratives.forEach(text => {
      const splitText = doc.splitTextToSize(`• ${text}`, pageWidth - 28);
      doc.text(splitText, 14, summaryY);
      summaryY += (splitText.length * 5) + 2;
    });

    // 2. STOCK POSITION
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('2. Stock Position & Offset', 14, summaryY + 5);
    
    autoTable(doc, {
      startY: summaryY + 10,
      head: [['Item', 'Ksh', 'Remarks']],
      body: [
        ['Stock before stock take', formatKsh(num(openingStock)), 'Opening valuation'],
        ['Stock after stock take', formatKsh(num(physicalStock)), 'Physical count'],
        [`Stock ${stockAndSalesResults.grossStockVariance >= 0 ? 'Shortage' : 'Surplus'}`, formatKsh(Math.abs(stockAndSalesResults.grossStockVariance)), `${(stockAndSalesResults.stockVariancePercentage || 0).toFixed(2)}% of opening`],
        ['Sales Variance Available', formatKsh(stockAndSalesResults.salesVariance), 'Credit-adjusted'],
        ['Less: Applied to offset', `(${formatKsh(stockAndSalesResults.salesOffset)})`, 'Transferred from sales'],
        ['Residual Stock Loss', formatKsh(stockAndSalesResults.residualStockLoss), 'Added to debt'],
      ],
      theme: 'grid',
      headStyles: { fillColor: [44, 62, 80] },
      styles: { fontSize: 8 }
    });

    // 3. SALES RECONCILIATION
    doc.setFontSize(11);
    doc.text('3. Sales Reconciliation (Credit-Adjusted)', 14, doc.lastAutoTable.finalY + 10);
    
    const salesTableBody = staff.map(s => {
      const adjSys = num(s.system) - num(s.credit);
      const variance = num(s.actual) - adjSys;
      return [s.name, formatKsh(num(s.actual)), formatKsh(num(s.system)), formatKsh(num(s.credit)), formatKsh(adjSys), formatKsh(variance)];
    });
    
    if (num(unallocatedActual) > 0 || num(unallocatedSystem) > 0) {
      const adjUnalloc = num(unallocatedSystem) - num(unallocatedCredit);
      salesTableBody.push(['Unallocated', formatKsh(num(unallocatedActual)), formatKsh(num(unallocatedSystem)), formatKsh(num(unallocatedCredit)), formatKsh(adjUnalloc), formatKsh(num(unallocatedActual) - adjUnalloc)]);
    }
    
    salesTableBody.push(['Branch Total', formatKsh(totalActual), formatKsh(totalSystem), formatKsh(totalCredit), formatKsh(adjustedSystemSales), formatKsh(stockAndSalesResults.salesVariance)]);

    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15,
      head: [['Staff', 'Actual Cash', 'System Sales', 'Credit Sales', 'Adj. System', 'Variance']],
      body: salesTableBody,
      theme: 'striped',
      headStyles: { fillColor: [44, 62, 80] },
      styles: { fontSize: 8 },
      didParseCell: function (data) {
        // Highlight negative variances in red
        if (data.section === 'body' && data.column.index === 5) {
          const val = data.cell.text[0];
          if (val.includes('-')) {
            data.cell.styles.textColor = [192, 57, 43];
          }
        }
      }
    });

    // 4. DEBT MOVEMENT
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('4. Branch Account Debt Movement', 14, doc.lastAutoTable.finalY + 10);

    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15,
      head: [['Position', 'Ksh', 'Remarks']],
      body: [
        [`Standing debt as at ${openingDebtDate}`, `(${formatKsh(num(openingDebt))})`, 'Opening'],
        [`Standing debt as at ${closingDebtDate}`, `(${formatKsh(num(originalClosingDebt))})`, 'Original closing'],
        ['Net debt reduction (Original)', formatKsh(debtResults.grossDebtReduction), `${(debtResults.debtReductionPercentage || 0).toFixed(2)}% change`],
        ['Add: Residual stock loss', formatKsh(stockAndSalesResults.residualStockLoss), 'Absorbed into debt'],
        ['Adjusted closing debt', `(${formatKsh(debtResults.adjustedClosingDebt)})`, 'Final obligation'],
        ['Actual Net Debt Reduction', formatKsh(debtResults.netDebtReduction), 'True reduction'],
      ],
      theme: 'grid',
      headStyles: { fillColor: [44, 62, 80] },
      styles: { fontSize: 8 }
    });

    // 5. GRAPHICAL ANALYSIS (NEW PAGE)
    doc.addPage();
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('5. Graphical Analysis', 14, 20);

    // Chart 1: Individual Sales (Actual vs Adjusted System)
    const salesChartData = staff.slice(0, 6).map(s => ({
      label: s.name,
      val1: num(s.actual),
      val2: num(s.system) - num(s.credit)
    }));
    salesChartData.push({ label: 'Branch', val1: totalActual, val2: adjustedSystemSales });

    drawBarChart(doc, 20, 40, 170, 60, salesChartData, 'Actual vs Adjusted System Sales per Staff');

    // Chart 2: Variance vs Stock Loss
    const reconData = [
      { label: 'Stock Loss', val1: stockAndSalesResults.grossStockShortage, val2: 0 },
      { label: 'Sales Offset', val1: stockAndSalesResults.salesOffset, val2: 0 },
      { label: 'Residual Loss', val1: stockAndSalesResults.residualStockLoss, val2: 0 }
    ];
    drawBarChart(doc, 20, 130, 80, 50, reconData, 'Stock Loss Reconciliation');

    // Chart 3: Debt
    const debtData = [
      { label: 'Opening', val1: num(openingDebt), val2: 0 },
      { label: 'Adjusted', val1: debtResults.adjustedClosingDebt, val2: 0 }
    ];
    drawBarChart(doc, 110, 130, 80, 50, debtData, 'Debt Movement (Ksh)');

    // Footer on every page
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(`Generated on ${new Date().toLocaleString()} | Page ${i} of ${pageCount}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
    }

    doc.save(`${branchName}_Financial_Report.pdf`);
  };

  const inputStyle = { width: '100%', padding: '8px', marginBottom: '10px', border: '1px solid #ccc', borderRadius: '4px' };
  const labelStyle = { display: 'block', marginBottom: '4px', fontWeight: 'bold', fontSize: '12px' };
  const cardStyle = { padding: '15px', backgroundColor: '#f9f9f9', borderRadius: '8px', marginBottom: '15px', border: '1px solid #ddd' };

  return (
    <main style={{ maxWidth: '1100px', margin: '40px auto', fontFamily: 'system-ui', padding: '0 20px' }}>
      <h1 style={{ borderBottom: '2px solid #333', paddingBottom: '10px' }}>Mediocare Stock Control</h1>
      
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', gap: '10px' }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Branch</label>
            <select value={selectedBranch} onChange={(e) => setSelectedBranch(e.target.value)} style={inputStyle}>
              <option value="">-- Choose --</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Start Date</label>
            <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>End Date</label>
            <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} style={inputStyle} />
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        
        {/* LEFT COLUMN */}
        <div>
          <div style={cardStyle}>
            <h3 style={{ marginTop: 0 }}>1. Stock Data</h3>
            <label style={labelStyle}>Opening Stock (Ksh)</label>
            <input type="number" value={openingStock} onChange={e => setOpeningStock(e.target.value)} style={inputStyle} />
            <label style={labelStyle}>Physical Stock (Ksh)</label>
            <input type="number" value={physicalStock} onChange={e => setPhysicalStock(e.target.value)} style={inputStyle} />
          </div>

          <div style={cardStyle}>
            <h3 style={{ marginTop: 0 }}>2. Debt Data</h3>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Opening Debt Date</label>
                <input type="date" value={openingDebtDate} onChange={e => setOpeningDebtDate(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Opening Debt (Ksh)</label>
                <input type="number" value={openingDebt} onChange={e => setOpeningDebt(e.target.value)} style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Closing Debt Date</label>
                <input type="date" value={closingDebtDate} onChange={e => setClosingDebtDate(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Original Closing Debt (Ksh)</label>
                <input type="number" value={originalClosingDebt} onChange={e => setOriginalClosingDebt(e.target.value)} style={inputStyle} />
              </div>
            </div>
          </div>
          
          <div style={cardStyle}>
            <h3 style={{ marginTop: 0 }}>3. Unallocated Sales</h3>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Actual Cash</label>
                <input type="number" value={unallocatedActual} onChange={e => setUnallocatedActual(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>System Sales</label>
                <input type="number" value={unallocatedSystem} onChange={e => setUnallocatedSystem(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Credit Sales</label>
                <input type="number" value={unallocatedCredit} onChange={e => setUnallocatedCredit(e.target.value)} style={inputStyle} />
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div>
          <div style={cardStyle}>
            <h3 style={{ marginTop: 0, display: 'flex', justifyContent: 'space-between' }}>
              4. Salespeople
              <button onClick={addStaff} style={{ padding: '5px 10px', cursor: 'pointer' }}>+ Add Row</button>
            </h3>
            {staff.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: '5px', marginBottom: '10px', alignItems: 'flex-end' }}>
                <div style={{ flex: 2 }}>
                  <label style={labelStyle}>Name</label>
                  <input type="text" value={s.name} onChange={e => handleStaffChange(i, 'name', e.target.value)} style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Actual</label>
                  <input type="number" value={s.actual} onChange={e => handleStaffChange(i, 'actual', e.target.value)} style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>System</label>
                  <input type="number" value={s.system} onChange={e => handleStaffChange(i, 'system', e.target.value)} style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Credit</label>
                  <input type="number" value={s.credit} onChange={e => handleStaffChange(i, 'credit', e.target.value)} style={inputStyle} />
                </div>
                <button onClick={() => removeStaff(i)} style={{ padding: '8px', backgroundColor: '#ff4d4f', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', marginBottom: '10px' }}>X</button>
              </div>
            ))}
          </div>

          <div style={{ ...cardStyle, backgroundColor: '#eef2f5' }}>
            <h3 style={{ marginTop: 0 }}>Live Results</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '14px' }}>
              <div><strong>Total Actual:</strong> Ksh {formatKsh(totalActual)}</div>
              <div><strong>Adj. System:</strong> Ksh {formatKsh(adjustedSystemSales)}</div>
              <div><strong>Gross Stock Var:</strong> Ksh {formatKsh(stockAndSalesResults.grossStockVariance)}</div>
              <div><strong>Sales Variance:</strong> Ksh {formatKsh(stockAndSalesResults.salesVariance)}</div>
              <div style={{ color: 'red' }}><strong>Residual Loss:</strong> Ksh {formatKsh(stockAndSalesResults.residualStockLoss)}</div>
              <div style={{ color: 'green' }}><strong>Adj. Debt:</strong> Ksh {formatKsh(debtResults.adjustedClosingDebt)}</div>
            </div>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <button onClick={generatePDF} style={{ width: '100%', padding: '15px', backgroundColor: '#000', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
              Download Smart PDF Report
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
