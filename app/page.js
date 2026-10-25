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

  // --- DYNAMIC STAFF HANDLING ---
  const handleStaffChange = (index, field, value) => {
    const newStaff = [...staff];
    newStaff[index][field] = value;
    setStaff(newStaff);
  };

  const addStaff = () => setStaff([...staff, { name: '', actual: '', system: '', credit: '' }]);
  const removeStaff = (index) => setStaff(staff.filter((_, i) => i !== index));

  // --- NATIVE PDF CHART ENGINE ---
  const drawBarChart = (doc, startX, startY, width, height, data, title, yLabel) => {
    // Determine max value for scaling
    let maxVal = 0;
    data.forEach(d => {
      if (d.val1 > maxVal) maxVal = d.val1;
      if (d.val2 > maxVal) maxVal = d.val2;
    });
    if (maxVal === 0) maxVal = 1;

    // Draw Title
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text(title, startX + width / 2, startY - 5, { align: 'center' });

    // Draw Axes
    doc.setDrawColor(0);
    doc.line(startX, startY + height, startX, startY); // Y-axis
    doc.line(startX, startY + height, startX + width, startY + height); // X-axis

    // Draw Y-axis Labels (approximate)
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(formatNum(maxVal), startX - 5, startY + 5, { align: 'right' });
    doc.text('0', startX - 5, startY + height, { align: 'right' });

    // Draw Bars
    const barGroupWidth = width / data.length;
    const barWidth = (barGroupWidth * 0.8) / 2;
    
    data.forEach((d, i) => {
      const groupX = startX + (i * barGroupWidth) + (barGroupWidth * 0.1);
      
      // Bar 1 (Actual / Before)
      const h1 = (d.val1 / maxVal) * height;
      doc.setFillColor(50, 50, 50); // Dark gray
      doc.rect(groupX, startY + height - h1, barWidth, h1, 'F');
      
      // Bar 2 (System / After)
      const h2 = (d.val2 / maxVal) * height;
      doc.setFillColor(150, 150, 150); // Light gray
      doc.rect(groupX + barWidth + 2, startY + height - h2, barWidth, h2, 'F');

      // X-axis Label
      doc.setFontSize(8);
      doc.text(d.label, groupX + barWidth, startY + height + 5, { align: 'center' });
    });

    // Legend
    doc.setFillColor(50, 50, 50);
    doc.rect(startX + width - 60, startY - 15, 5, 5, 'F');
    doc.text('Actual/Before', startX + width - 52, startY - 10);
    
    doc.setFillColor(150, 150, 150);
    doc.rect(startX + width - 60, startY - 8, 5, 5, 'F');
    doc.text('System/After', startX + width - 52, startY - 3);
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
    doc.text(`Reporting Period: ${periodStart} to ${periodEnd}`, pageWidth / 2, 34, { align: 'center' });

    // 1. EXECUTIVE SUMMARY
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('1. Executive Summary', 14, 45);
    
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    let summaryY = 52;
    
    // Dynamic summary text
    const varType = stockAndSalesResults.salesVariance >= 0 ? 'surplus' : 'shortage';
    const stockType = stockAndSalesResults.grossStockVariance >= 0 ? 'loss' : 'surplus';
    
    doc.text(`• Credit-adjusted sales ${varType}: Ksh ${formatKsh(Math.abs(stockAndSalesResults.salesVariance))}`, 14, summaryY); summaryY += 6;
    doc.text(`• Stock ${stockType}: Ksh ${formatKsh(Math.abs(stockAndSalesResults.grossStockVariance))}; offset by sales variance.`, 14, summaryY); summaryY += 6;
    doc.text(`• Residual stock loss: Ksh ${formatKsh(stockAndSalesResults.residualStockLoss)}`, 14, summaryY); summaryY += 6;
    doc.text(`• Debt reduced by Ksh ${formatKsh(debtResults.netDebtReduction)} to Ksh ${formatKsh(debtResults.adjustedClosingDebt)}.`, 14, summaryY); summaryY += 6;

    // 2. STOCK POSITION AND OFFSET
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('2. Stock Position and Offset', 14, summaryY + 5);
    
    autoTable(doc, {
      startY: summaryY + 10,
      head: [['Item', 'Ksh', 'Note']],
      body: [
        ['Stock before stock take', formatKsh(num(openingStock)), 'Opening'],
        ['Stock after stock take', formatKsh(num(physicalStock)), 'Closing'],
        ['Stock loss/surplus', formatKsh(stockAndSalesResults.grossStockVariance), `${(stockAndSalesResults.stockVariancePercentage || 0).toFixed(2)}% of opening`],
        ['Sales surplus/shortage available', formatKsh(stockAndSalesResults.salesVariance), 'Credit-adjusted'],
        ['Less: applied to stock loss', `(${formatKsh(stockAndSalesResults.salesOffset)})`, 'Full offset' ],
        ['Residual stock loss', formatKsh(stockAndSalesResults.residualStockLoss), 'After offset'],
      ],
      theme: 'grid',
      headStyles: { fillColor: [0, 51, 102] },
      styles: { fontSize: 8 }
    });

    // 3. SALES RECONCILIATION (CREDIT-ADJUSTED)
    doc.setFontSize(11);
    doc.text('3. Sales Reconciliation (Credit-Adjusted)', 14, doc.lastAutoTable.finalY + 10);
    
    const salesTableBody = staff.map(s => {
      const adjSys = num(s.system) - num(s.credit);
      const variance = num(s.actual) - adjSys;
      return [s.name, formatKsh(num(s.actual)), formatKsh(num(s.system)), formatKsh(num(s.credit)), formatKsh(adjSys), formatKsh(variance)];
    });
    
    // Add unallocated and total
    salesTableBody.push(['Unallocated', formatKsh(num(unallocatedActual)), formatKsh(num(unallocatedSystem)), formatKsh(num(unallocatedCredit)), formatKsh(num(unallocatedSystem) - num(unallocatedCredit)), formatKsh(num(unallocatedActual) - (num(unallocatedSystem) - num(unallocatedCredit)))]);
    salesTableBody.push(['Branch Total', formatKsh(totalActual), formatKsh(totalSystem), formatKsh(totalCredit), formatKsh(adjustedSystemSales), formatKsh(stockAndSalesResults.salesVariance)]);

    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15,
      head: [['Staff', 'Actual Cash', 'System Sales', 'Credit Sales', 'Adj. System', 'Variance']],
      body: salesTableBody,
      theme: 'striped',
      headStyles: { fillColor: [41, 128, 185] },
      styles: { fontSize: 8 }
    });

    // 4. DEBT POSITION
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('4. Branch Account Debt Movement', 14, doc.lastAutoTable.finalY + 10);

    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15,
      head: [['Position', 'Ksh', 'Change %']],
      body: [
        [`Standing debt as at ${openingDebtDate}`, `(${formatKsh(num(openingDebt))})`, '—'],
        [`Standing debt as at ${closingDebtDate}`, `(${formatKsh(num(originalClosingDebt))})`, '—'],
        ['Net debt reduction (original)', formatKsh(debtResults.grossDebtReduction), `${(debtResults.debtReductionPercentage || 0).toFixed(2)}%`],
        ['Add: Residual stock loss', formatKsh(stockAndSalesResults.residualStockLoss), 'Absorbed'],
        ['Adjusted closing debt', `(${formatKsh(debtResults.adjustedClosingDebt)})`, 'Adjusted'],
        ['Actual Net Reduction', formatKsh(debtResults.netDebtReduction), `${((debtResults.netDebtReduction / num(openingDebt)) * 100 || 0).toFixed(2)}%`],
      ],
      theme: 'grid',
      headStyles: { fillColor: [39, 174, 96] },
      styles: { fontSize: 8 }
    });

    // 5. GRAPHICAL ANALYSIS (NEW PAGE)
    doc.addPage();
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('5. Graphical Analysis', 14, 20);

    // Chart 1: Sales (Actual vs Adjusted System per person)
    const salesChartData = staff.slice(0, 5).map(s => ({
      label: s.name.substring(0, 8),
      val1: num(s.actual),
      val2: num(s.system) - num(s.credit)
    }));
    // Add Branch total to chart
    salesChartData.push({ label: 'Branch', val1: totalActual, val2: adjustedSystemSales });

    drawBarChart(doc, 20, 40, 170, 60, salesChartData, 'Individual Sales: Actual vs Adjusted System', 'Ksh');

    // Chart 2: Stock and Debt
    drawBarChart(doc, 20, 130, 80, 50, [
      { label: 'Before', val1: num(openingStock), val2: 0 },
      { label: 'After', val1: num(physicalStock), val2: 0 }
    ], 'Stock Value Movement', 'Ksh');

    drawBarChart(doc, 110, 130, 80, 50, [
      { label: 'Opening', val1: num(openingDebt), val2: 0 },
      { label: 'Adjusted', val1: debtResults.adjustedClosingDebt, val2: 0 }
    ], 'Debt Movement', 'Ksh');

    // Footer on every page
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
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
        
        {/* LEFT COLUMN: INPUTS */}
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

        {/* RIGHT COLUMN: STAFF & RESULTS */}
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
              Download Professional PDF Report
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
