'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { calculateStockAndSales, calculateDebt } from '../lib/calculations';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export default function Home() {
  const [activeTab, setActiveTab] = useState('create'); // 'create' or 'history'
  const [branches, setBranches] = useState([]);
  const [isSaving, setIsSaving] = useState(false);

  // --- STATE FOR NEW REPORT ---
  const [selectedBranch, setSelectedBranch] = useState('');
  const [openingStock, setOpeningStock] = useState('');
  const [physicalStock, setPhysicalStock] = useState('');
  const [openingDebt, setOpeningDebt] = useState('');
  const [originalClosingDebt, setOriginalClosingDebt] = useState('');
  const [unallocatedActual, setUnallocatedActual] = useState('');
  const [unallocatedSystem, setUnallocatedSystem] = useState('');
  const [unallocatedCredit, setUnallocatedCredit] = useState('');
  const today = new Date().toISOString().split('T')[0];
  const [periodStart, setPeriodStart] = useState(today);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [openingDebtDate, setOpeningDebtDate] = useState(today);
  const [closingDebtDate, setClosingDebtDate] = useState(today);
  const [staff, setStaff] = useState([{ name: '', actual: '', system: '', credit: '' }]);

  // --- STATE FOR HISTORY ---
  const [historicalReports, setHistoricalReports] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  useEffect(() => {
    async function getBranches() {
      const { data } = await supabase.from('branches').select('*').order('name');
      if (data) setBranches(data);
    }
    getBranches();
  }, []);

  useEffect(() => {
    if (activeTab === 'history') {
      fetchHistory();
    }
  }, [activeTab]);

  const fetchHistory = async () => {
    setIsLoadingHistory(true);
    // Fetch reports with their related stock, debt, and sales data
    const { data, error } = await supabase
      .from('reports')
      .select(`
        id, period_start, period_end, status, created_at,
        branches (name),
        stock_takes (opening_stock, physical_stock),
        debt_records (opening_debt, original_closing_debt, residual_stock_loss_added, opening_debt_date, closing_debt_date),
        sales_records (actual_sales, system_sales, credit_sales, salespeople (name))
      `)
      .order('created_at', { ascending: false });

    if (error) {
      console.error(error);
      alert('Error fetching history: ' + error.message);
    } else {
      setHistoricalReports(data || []);
    }
    setIsLoadingHistory(false);
  };

  const num = (val) => parseFloat(val) || 0;
  const formatKsh = (amount) => new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  const formatNum = (amount) => new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 }).format(amount);

  // --- NEW REPORT CALCULATIONS ---
  const totalActual = staff.reduce((sum, s) => sum + num(s.actual), 0) + num(unallocatedActual);
  const totalSystem = staff.reduce((sum, s) => sum + num(s.system), 0) + num(unallocatedSystem);
  const totalCredit = staff.reduce((sum, s) => sum + num(s.credit), 0) + num(unallocatedCredit);
  const adjustedSystemSales = totalSystem - totalCredit;

  const stockAndSalesResults = calculateStockAndSales(num(openingStock), num(physicalStock), totalActual, adjustedSystemSales);
  const debtResults = calculateDebt(num(openingDebt), num(originalClosingDebt), stockAndSalesResults.residualStockLoss);
  const branchName = branches.find(b => b.id === selectedBranch)?.name || '';

  const handleStaffChange = (index, field, value) => {
    const newStaff = [...staff];
    newStaff[index][field] = value;
    setStaff(newStaff);
  };

  const addStaff = () => setStaff([...staff, { name: '', actual: '', system: '', credit: '' }]);
  const removeStaff = (index) => setStaff(staff.filter((_, i) => i !== index));

  // --- SAVE NEW REPORT ---
  const handleSave = async () => {
    if (!selectedBranch) return alert('Please select a branch first.');
    setIsSaving(true);

    try {
      const { data: reportData, error: reportError } = await supabase
        .from('reports')
        .insert({ branch_id: selectedBranch, period_start: periodStart, period_end: periodEnd, status: 'Draft' })
        .select().single();

      if (reportError) throw reportError;
      const reportId = reportData.id;

      await supabase.from('stock_takes').insert({
        report_id: reportId, opening_stock: num(openingStock), physical_stock: num(physicalStock), stock_date: today
      });

      await supabase.from('debt_records').insert({
        report_id: reportId, opening_debt: num(openingDebt), original_closing_debt: num(originalClosingDebt), 
        residual_stock_loss_added: stockAndSalesResults.residualStockLoss, opening_debt_date: openingDebtDate, closing_debt_date: closingDebtDate
      });

      for (const person of staff) {
        if (!person.name) continue;
        let { data: existingStaff } = await supabase.from('salespeople').select('id').eq('branch_id', selectedBranch).eq('name', person.name).limit(1);
        let spId;
        if (existingStaff && existingStaff.length > 0) {
          spId = existingStaff[0].id;
        } else {
          const { data: newSp } = await supabase.from('salespeople').insert({ branch_id: selectedBranch, name: person.name }).select().single();
          spId = newSp.id;
        }
        await supabase.from('sales_records').insert({
          report_id: reportId, salesperson_id: spId, actual_sales: num(person.actual), system_sales: num(person.system), credit_sales: num(person.credit)
        });
      }

      alert('Report saved successfully! You can now view it in the History tab.');
      setActiveTab('history'); // Switch to history automatically
    } catch (err) {
      alert('Error saving: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  // --- PDF GENERATOR (ACCEPTS DATA OBJECT SO IT WORKS FOR LIVE AND HISTORY) ---
  const drawBarChart = (doc, startX, startY, width, height, data, title) => {
    let maxVal = 0, minVal = 0;
    data.forEach(d => {
      if (d.val1 > maxVal) maxVal = d.val1; if (d.val1 < minVal) minVal = d.val1;
      if (d.val2 > maxVal) maxVal = d.val2; if (d.val2 < minVal) minVal = d.val2;
    });
    const range = Math.max(maxVal - minVal, 1);
    maxVal += range * 0.15; minVal -= range * 0.15;
    const zeroLineY = startY + height - ((0 - minVal) / (maxVal - minVal)) * height;

    doc.setFontSize(9); doc.setFont('helvetica', 'bold');
    doc.text(title, startX + width / 2, startY - 5, { align: 'center' });
    doc.setDrawColor(150); doc.setLineWidth(0.5);
    doc.line(startX, startY, startX, startY + height); doc.line(startX, zeroLineY, startX + width, zeroLineY);

    doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(100);
    doc.text(formatNum(maxVal), startX - 2, startY + 4, { align: 'right' });
    doc.text('0', startX - 2, zeroLineY + 2, { align: 'right' });
    if (minVal < 0) doc.text(formatNum(minVal), startX - 2, startY + height, { align: 'right' });

    const barGroupWidth = width / data.length; const barWidth = (barGroupWidth * 0.7) / 2;
    data.forEach((d, i) => {
      const groupX = startX + (i * barGroupWidth) + (barGroupWidth * 0.15);
      const h1 = ((d.val1 - 0) / (maxVal - minVal)) * height; const y1 = zeroLineY - h1;
      doc.setFillColor(41, 128, 185); doc.rect(groupX, h1 > 0 ? y1 : zeroLineY, barWidth, Math.abs(h1), 'F');
      const h2 = ((d.val2 - 0) / (maxVal - minVal)) * height; const y2 = zeroLineY - h2;
      doc.setFillColor(211, 84, 0); doc.rect(groupX + barWidth + 1, h2 > 0 ? y2 : zeroLineY, barWidth, Math.abs(h2), 'F');

      doc.setFontSize(6); doc.setTextColor(0);
      if (d.val1 !== 0) doc.text(formatNum(d.val1), groupX + (barWidth/2), y1 - 2, { align: 'center' });
      if (d.val2 !== 0) doc.text(formatNum(d.val2), groupX + barWidth + 1 + (barWidth/2), y2 - 2, { align: 'center' });
      doc.setFontSize(7); doc.text(d.label.substring(0, 6), groupX + barWidth, startY + height + 4, { align: 'center' });
    });

    doc.setFillColor(41, 128, 185); doc.rect(startX + width - 50, startY - 10, 4, 4, 'F');
    doc.setFontSize(7); doc.setTextColor(0); doc.text('Actual', startX + width - 44, startY - 7);
    doc.setFillColor(211, 84, 0); doc.rect(startX + width - 25, startY - 10, 4, 4, 'F');
    doc.text('System', startX + width - 19, startY - 7);
  };

  const generatePDF = (data) => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    // Header
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text('MEDIOCARE PHARMACEUTICALS LTD', pageWidth / 2, 20, { align: 'center' });
    doc.setFontSize(12);
    doc.text(`${data.branchName.toUpperCase()} — STOCK CONTROL & FINANCIAL REPORT`, pageWidth / 2, 28, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(`Period: ${data.periodStart} to ${data.periodEnd} | Currency: KES`, pageWidth / 2, 34, { align: 'center' });

    // 1. Executive Summary
    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('1. Executive Summary', 14, 45);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    let summaryY = 52;
    
    let narr = [];
    if (data.results.salesVariance > 0) narr.push(`Positive sales variance of Ksh ${formatKsh(data.results.salesVariance)} indicates unrecorded cash.`);
    else if (data.results.salesVariance < 0) narr.push(`Negative sales variance of Ksh ${formatKsh(Math.abs(data.results.salesVariance))} requires investigation.`);
    if (data.results.grossStockVariance > 0) narr.push(`Stock shortage of Ksh ${formatKsh(data.results.grossStockVariance)}.`);
    if (data.results.residualStockLoss > 0) narr.push(`Residual loss of Ksh ${formatKsh(data.results.residualStockLoss)} added to debt.`);
    if (data.debtResults.netDebtReduction > 0) narr.push(`Debt reduced by Ksh ${formatKsh(data.debtResults.netDebtReduction)}.`);
    
    narr.forEach(text => {
      const splitText = doc.splitTextToSize(`• ${text}`, pageWidth - 28);
      doc.text(splitText, 14, summaryY); summaryY += (splitText.length * 5) + 2;
    });

    // 2. Stock Position
    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('2. Stock Position & Offset', 14, summaryY + 5);
    autoTable(doc, {
      startY: summaryY + 10,
      head: [['Item', 'Ksh', 'Remarks']],
      body: [
        ['Stock before stock take', formatKsh(data.openingStock), 'Opening'],
        ['Stock after stock take', formatKsh(data.physicalStock), 'Physical'],
        ['Stock Shortage/Surplus', formatKsh(data.results.grossStockVariance), 'Difference'],
        ['Sales Variance Available', formatKsh(data.results.salesVariance), 'Credit-adjusted'],
        ['Less: Applied to offset', `(${formatKsh(data.results.salesOffset)})`, 'Offset'],
        ['Residual Stock Loss', formatKsh(data.results.residualStockLoss), 'To debt'],
      ],
      theme: 'grid', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 }
    });

    // 3. Sales Reconciliation
    doc.setFontSize(11); doc.text('3. Sales Reconciliation', 14, doc.lastAutoTable.finalY + 10);
    const salesBody = data.staff.map(s => [s.name, formatKsh(s.actual), formatKsh(s.system), formatKsh(s.credit), formatKsh(s.actual - (s.system - s.credit))]);
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15,
      head: [['Staff', 'Actual', 'System', 'Credit', 'Variance']],
      body: salesBody,
      theme: 'striped', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 }
    });

    // 4. Debt
    doc.setFontSize(11); doc.text('4. Debt Movement', 14, doc.lastAutoTable.finalY + 10);
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15,
      head: [['Position', 'Ksh', 'Remarks']],
      body: [
        ['Opening Debt', `(${formatKsh(data.openingDebt)})`, 'Opening'],
        ['Original Closing Debt', `(${formatKsh(data.originalClosingDebt)})`, 'Closing'],
        ['Adjusted Closing Debt', `(${formatKsh(data.debtResults.adjustedClosingDebt)})`, 'Final'],
        ['Actual Net Reduction', formatKsh(data.debtResults.netDebtReduction), 'True reduction'],
      ],
      theme: 'grid', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 }
    });

    // 5. Graphs
    doc.addPage();
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.text('5. Graphical Analysis', 14, 20);
    const chartData = data.staff.slice(0, 6).map(s => ({ label: s.name, val1: s.actual, val2: s.system - s.credit }));
    drawBarChart(doc, 20, 40, 170, 60, chartData, 'Actual vs Adjusted System Sales');
    
    const reconData = [
      { label: 'Stock Loss', val1: data.results.grossStockShortage, val2: 0 },
      { label: 'Sales Offset', val1: data.results.salesOffset, val2: 0 },
      { label: 'Residual', val1: data.results.residualStockLoss, val2: 0 }
    ];
    drawBarChart(doc, 20, 130, 80, 50, reconData, 'Stock Loss Reconciliation');
    drawBarChart(doc, 110, 130, 80, 50, [
      { label: 'Open', val1: data.openingDebt, val2: 0 }, { label: 'Adj Close', val1: data.debtResults.adjustedClosingDebt, val2: 0 }
    ], 'Debt Movement');

    doc.save(`${data.branchName}_Report.pdf`);
  };

  const handleGenerateLive = () => {
    if (!selectedBranch) return alert('Select a branch');
    const liveData = {
      branchName, periodStart, periodEnd, openingStock: num(openingStock), physicalStock: num(physicalStock),
      openingDebt: num(openingDebt), originalClosingDebt: num(originalClosingDebt),
      results: stockAndSalesResults, debtResults,
      staff: staff.map(s => ({ name: s.name, actual: num(s.actual), system: num(s.system), credit: num(s.credit) }))
    };
    generatePDF(liveData);
  };

  const handleGenerateHistory = (report) => {
    const openingStock = report.stock_takes?.[0]?.opening_stock || 0;
    const physicalStock = report.stock_takes?.[0]?.physical_stock || 0;
    const openingDebt = report.debt_records?.[0]?.opening_debt || 0;
    const originalClosingDebt = report.debt_records?.[0]?.original_closing_debt || 0;
    
    const staffData = (report.sales_records || []).map(sr => ({
      name: sr.salespeople?.name || 'Unknown',
      actual: sr.actual_sales || 0,
      system: sr.system_sales || 0,
      credit: sr.credit_sales || 0
    }));

    const totalActual = staffData.reduce((sum, s) => sum + s.actual, 0);
    const totalSystem = staffData.reduce((sum, s) => sum + s.system, 0);
    const totalCredit = staffData.reduce((sum, s) => sum + s.credit, 0);
    const adjSys = totalSystem - totalCredit;

    const results = calculateStockAndSales(openingStock, physicalStock, totalActual, adjSys);
    const debtResults = calculateDebt(openingDebt, originalClosingDebt, results.residualStockLoss);

    generatePDF({
      branchName: report.branches?.name || 'Unknown',
      periodStart: report.period_start,
      periodEnd: report.period_end,
      openingStock, physicalStock, openingDebt, originalClosingDebt,
      results, debtResults, staff: staffData
    });
  };

  const inputStyle = { width: '100%', padding: '8px', marginBottom: '10px', border: '1px solid #ccc', borderRadius: '4px' };
  const labelStyle = { display: 'block', marginBottom: '4px', fontWeight: 'bold', fontSize: '12px' };
  const cardStyle = { padding: '15px', backgroundColor: '#f9f9f9', borderRadius: '8px', marginBottom: '15px', border: '1px solid #ddd' };

  return (
    <main style={{ maxWidth: '1100px', margin: '40px auto', fontFamily: 'system-ui', padding: '0 20px' }}>
      
      {/* HEADER & TABS */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #333', paddingBottom: '10px', marginBottom: '20px' }}>
        <h1 style={{ margin: 0 }}>Mediocare System</h1>
        <div>
          <button onClick={() => setActiveTab('create')} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'create' ? '#333' : '#eee', color: activeTab === 'create' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>New Report</button>
          <button onClick={() => setActiveTab('history')} style={{ padding: '10px 20px', backgroundColor: activeTab === 'history' ? '#333' : '#eee', color: activeTab === 'history' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>History</button>
        </div>
      </div>

      {activeTab === 'create' ? (
        // ================= CREATE TAB =================
        <div>
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
            </div>

            <div>
              <div style={cardStyle}>
                <h3 style={{ marginTop: 0, display: 'flex', justifyContent: 'space-between' }}>
                  3. Salespeople
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
                  <div><strong>Sales Variance:</strong> Ksh {formatKsh(stockAndSalesResults.salesVariance)}</div>
                  <div style={{ color: 'red' }}><strong>Residual Loss:</strong> Ksh {formatKsh(stockAndSalesResults.residualStockLoss)}</div>
                  <div style={{ color: 'green' }}><strong>Adj. Debt:</strong> Ksh {formatKsh(debtResults.adjustedClosingDebt)}</div>
                </div>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <button onClick={handleSave} disabled={isSaving} style={{ width: '100%', padding: '15px', backgroundColor: '#0070f3', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                  {isSaving ? 'Saving...' : 'Save Report to Database'}
                </button>
                <button onClick={handleGenerateLive} style={{ width: '100%', padding: '15px', backgroundColor: '#000', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                  Generate Live PDF (Preview)
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        // ================= HISTORY TAB =================
        <div style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Saved Reports</h2>
          {isLoadingHistory ? <p>Loading history...</p> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #ddd', backgroundColor: '#f5f5f5' }}>
                  <th style={{ padding: '10px' }}>Date Created</th>
                  <th style={{ padding: '10px' }}>Branch</th>
                  <th style={{ padding: '10px' }}>Period</th>
                  <th style={{ padding: '10px' }}>Status</th>
                  <th style={{ padding: '10px' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {historicalReports.length === 0 ? (
                  <tr><td colSpan="5" style={{ padding: '20px', textAlign: 'center' }}>No reports found. Create one first!</td></tr>
                ) : (
                  historicalReports.map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: '10px' }}>{new Date(r.created_at).toLocaleDateString()}</td>
                      <td style={{ padding: '10px', fontWeight: 'bold' }}>{r.branches?.name}</td>
                      <td style={{ padding: '10px' }}>{r.period_start} to {r.period_end}</td>
                      <td style={{ padding: '10px' }}>
                        <span style={{ padding: '4px 8px', backgroundColor: r.status === 'Draft' ? '#ff9800' : '#4caf50', color: '#fff', borderRadius: '12px', fontSize: '12px' }}>{r.status}</span>
                      </td>
                      <td style={{ padding: '10px' }}>
                        <button onClick={() => handleGenerateHistory(r)} style={{ padding: '8px 12px', backgroundColor: '#000', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Download PDF</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </main>
  );
}
