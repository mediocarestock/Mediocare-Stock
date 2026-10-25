'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { calculateStockAndSales, calculateDebt } from '../lib/calculations';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import Papa from 'papaparse';

export default function Home() {
  // --- AUTH STATE ---
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(true);

  // --- UI STATE ---
  const [activeTab, setActiveTab] = useState('dashboard'); 
  const [branches, setBranches] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [viewingReport, setViewingReport] = useState(null);

  // --- DASHBOARD STATE ---
  const [dashboardStats, setDashboardStats] = useState({
    totalBranches: 17, pendingReports: 0, totalStockLoss: 0, totalAdjustedDebt: 0
  });

  // --- CREATE / EDIT REPORT STATE ---
  const [editingReportId, setEditingReportId] = useState(null);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [openingStock, setOpeningStock] = useState('');
  const [physicalStock, setPhysicalStock] = useState('');
  const [openingDebt, setOpeningDebt] = useState('');
  const [originalClosingDebt, setOriginalClosingDebt] = useState('');
  const today = new Date().toISOString().split('T')[0];
  const [periodStart, setPeriodStart] = useState(today);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [openingDebtDate, setOpeningDebtDate] = useState(today);
  const [closingDebtDate, setClosingDebtDate] = useState(today);
  const [staff, setStaff] = useState([{ name: '', actual: '', system: '', credit: '' }]);

  // --- HISTORY & CONSOLIDATED STATE ---
  const [historicalReports, setHistoricalReports] = useState([]);
  const [consolidatedData, setConsolidatedData] = useState([]);
  const [isLoadingData, setIsLoadingData] = useState(false);

  // --- AUTH LISTENER ---
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) {
      supabase.from('branches').select('*').order('name').then(({ data }) => {
        if (data) {
          setBranches(data);
          setDashboardStats(prev => ({ ...prev, totalBranches: data.length }));
        }
      });
    }
  }, [session]);

  useEffect(() => {
    if (activeTab === 'dashboard') fetchDashboardData();
    if (activeTab === 'history') fetchHistory();
    if (activeTab === 'consolidated') fetchConsolidated();
  }, [activeTab]);

  // --- HELPERS ---
  const num = (val) => parseFloat(val) || 0;
  const formatKsh = (amount) => new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  const formatNum = (amount) => new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 }).format(amount);

  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (results) => {
        const newStaff = results.data.map(row => ({
          name: row.Name || row.name || 'Unknown',
          actual: row.Actual || row.actual || '',
          system: row.System || row.system || '',
          credit: row.Credit || row.credit || ''
        }));
        setStaff(prev => [...prev.filter(s => s.name !== ''), ...newStaff]);
      }
    });
  };

  // --- CALCULATIONS ---
  const totalActual = staff.reduce((sum, s) => sum + num(s.actual), 0);
  const totalSystem = staff.reduce((sum, s) => sum + num(s.system), 0);
  const totalCredit = staff.reduce((sum, s) => sum + num(s.credit), 0);
  const adjustedSystemSales = totalSystem - totalCredit;
  
  const stockAndSalesResults = calculateStockAndSales(num(openingStock), num(physicalStock), totalActual, adjustedSystemSales);
  const debtResults = calculateDebt(num(openingDebt), num(originalClosingDebt), stockAndSalesResults.residualStockLoss);
  const branchName = branches.find(b => b.id === selectedBranch)?.name || '';

  // --- SAVE / UPDATE DATABASE ---
  const handleSave = async () => {
    if (!selectedBranch) return alert('Please select a branch first.');
    setIsSaving(true);
    try {
      let reportId = editingReportId;

      if (editingReportId) {
        await supabase.from('reports').update({ branch_id: selectedBranch, period_start: periodStart, period_end: periodEnd }).eq('id', editingReportId);
        await supabase.from('stock_takes').delete().eq('report_id', editingReportId);
        await supabase.from('debt_records').delete().eq('report_id', editingReportId);
        await supabase.from('sales_records').delete().eq('report_id', editingReportId);
      } else {
        const { data: reportData, error: reportError } = await supabase.from('reports').insert({ 
          branch_id: selectedBranch, period_start: periodStart, period_end: periodEnd, status: 'Draft' 
        }).select().single();
        if (reportError) throw reportError;
        reportId = reportData.id;
      }
      
      await supabase.from('stock_takes').insert({ 
        report_id: reportId, opening_stock: num(openingStock), physical_stock: num(physicalStock), stock_date: today, valuation_date: periodStart, physical_count_date: periodEnd 
      });
      
      await supabase.from('debt_records').insert({ 
        report_id: reportId, opening_debt: num(openingDebt), original_closing_debt: num(originalClosingDebt), residual_stock_loss_added: stockAndSalesResults.residualStockLoss, opening_debt_date: openingDebtDate, closing_debt_date: closingDebtDate 
      });

      for (const person of staff) {
        if (!person.name) continue;
        let { data: existingStaff } = await supabase.from('salespeople').select('id').eq('branch_id', selectedBranch).eq('name', person.name).limit(1);
        let spId = existingStaff?.[0]?.id;
        if (!spId) {
          const { data: newSp } = await supabase.from('salespeople').insert({ branch_id: selectedBranch, name: person.name }).select().single();
          spId = newSp.id;
        }
        await supabase.from('sales_records').insert({ report_id: reportId, salesperson_id: spId, actual_sales: num(person.actual), system_sales: num(person.system), credit_sales: num(person.credit) });
      }
      
      alert(editingReportId ? 'Report updated successfully!' : 'Report saved successfully!');
      resetForm();
      setActiveTab('history');
    } catch (err) {
      alert('Error saving: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const resetForm = () => {
    setEditingReportId(null); setSelectedBranch(''); setOpeningStock(''); setPhysicalStock('');
    setOpeningDebt(''); setOriginalClosingDebt(''); setStaff([{ name: '', actual: '', system: '', credit: '' }]);
    setPeriodStart(today); setPeriodEnd(today);
  };

  const handleEditReport = (report) => {
    if (report.status === 'Approved') return alert('Cannot edit an approved report.');
    
    setEditingReportId(report.id);
    setSelectedBranch(report.branch_id);
    setPeriodStart(report.period_start);
    setPeriodEnd(report.period_end);
    
    setOpeningStock(report.stock_takes?.[0]?.opening_stock || '');
    setPhysicalStock(report.stock_takes?.[0]?.physical_stock || '');
    setOpeningDebt(report.debt_records?.[0]?.opening_debt || '');
    setOriginalClosingDebt(report.debt_records?.[0]?.original_closing_debt || '');
    setOpeningDebtDate(report.debt_records?.[0]?.opening_debt_date || today);
    setClosingDebtDate(report.debt_records?.[0]?.closing_debt_date || today);

    if (report.sales_records && report.sales_records.length > 0) {
      setStaff(report.sales_records.map(sr => ({
        name: sr.salespeople?.name || '',
        actual: sr.actual_sales || '',
        system: sr.system_sales || '',
        credit: sr.credit_sales || ''
      })));
    } else {
      setStaff([{ name: '', actual: '', system: '', credit: '' }]);
    }
    setActiveTab('create');
  };

  const handleApprove = async (reportId) => {
    if(!confirm("Are you sure you want to approve this report? Once approved, it is locked.")) return;
    const { error } = await supabase.from('reports').update({ status: 'Approved' }).eq('id', reportId);
    if (error) alert("Error approving: " + error.message);
    else { alert("Report Approved."); fetchHistory(); }
  };

  // --- FETCH DATA ---
  const fetchDashboardData = async () => {
    setIsLoadingData(true);
    const { data } = await supabase.from('reports').select(`
      id, status, stock_takes(opening_stock, physical_stock), debt_records(opening_debt, original_closing_debt), sales_records(actual_sales, system_sales, credit_sales)
    `);
    if (data) {
      let pending = 0, tStockLoss = 0, tAdjDebt = 0;
      data.forEach(r => {
        if (r.status !== 'Approved') pending++;
        const tAct = r.sales_records?.reduce((s, x) => s + x.actual_sales, 0) || 0;
        const tSys = r.sales_records?.reduce((s, x) => s + x.system_sales, 0) || 0;
        const tCre = r.sales_records?.reduce((s, x) => s + x.credit_sales, 0) || 0;
        const oStk = r.stock_takes?.[0]?.opening_stock || 0;
        const pStk = r.stock_takes?.[0]?.physical_stock || 0;
        const oDebt = r.debt_records?.[0]?.opening_debt || 0;
        const cDebt = r.debt_records?.[0]?.original_closing_debt || 0;

        const res = calculateStockAndSales(oStk, pStk, tAct, tSys - tCre);
        const db = calculateDebt(oDebt, cDebt, res.residualStockLoss);
        tStockLoss += res.residualStockLoss; tAdjDebt += db.adjustedClosingDebt;
      });
      setDashboardStats(prev => ({ ...prev, pendingReports: pending, totalStockLoss: tStockLoss, totalAdjustedDebt: tAdjDebt }));
    }
    setIsLoadingData(false);
  };

  const fetchHistory = async () => {
    setIsLoadingData(true);
    const { data: reports, error } = await supabase.from('reports').select('*, branches(name)').order('created_at', { ascending: false });
    
    if (error) { alert("Error loading history: " + error.message); setIsLoadingData(false); return; }

    const fullReports = [];
    for (const r of reports) {
      const { data: st } = await supabase.from('stock_takes').select('*').eq('report_id', r.id);
      const { data: dr } = await supabase.from('debt_records').select('*').eq('report_id', r.id);
      const { data: sr } = await supabase.from('sales_records').select('*, salespeople(name)').eq('report_id', r.id);
      
      fullReports.push({ ...r, stock_takes: st || [], debt_records: dr || [], sales_records: sr || [] });
    }
    setHistoricalReports(fullReports);
    setIsLoadingData(false);
  };

  const fetchConsolidated = async () => {
    setIsLoadingData(true);
    const { data } = await supabase.from('reports').select(`
      id, period_start, period_end, branch_id, status, branches(name), stock_takes(opening_stock, physical_stock), debt_records(opening_debt, original_closing_debt), sales_records(actual_sales, system_sales, credit_sales)
    `).order('created_at', { ascending: false });

    if (data) {
      const grouped = {};
      data.forEach(r => {
        if (!grouped[r.branch_id] || r.status === 'Approved') {
          const tAct = r.sales_records.reduce((s, x) => s + x.actual_sales, 0);
          const tSys = r.sales_records.reduce((s, x) => s + x.system_sales, 0);
          const tCre = r.sales_records.reduce((s, x) => s + x.credit_sales, 0);
          const oStk = r.stock_takes?.[0]?.opening_stock || 0;
          const pStk = r.stock_takes?.[0]?.physical_stock || 0;
          const oDebt = r.debt_records?.[0]?.opening_debt || 0;
          const cDebt = r.debt_records?.[0]?.original_closing_debt || 0;

          const results = calculateStockAndSales(oStk, pStk, tAct, tSys - tCre);
          const debt = calculateDebt(oDebt, cDebt, results.residualStockLoss);

          grouped[r.branch_id] = {
            name: r.branches?.name || 'Unknown', period: `${r.period_start} to ${r.period_end}`, status: r.status,
            openingDebt: oDebt, adjClosingDebt: debt.adjustedClosingDebt, netReduction: debt.netDebtReduction, stockLoss: results.grossStockVariance, salesVariance: results.salesVariance
          };
        }
      });
      setConsolidatedData(Object.values(grouped));
    }
    setIsLoadingData(false);
  };

  // --- SMART PDF ENGINE ---
  const drawBarChart = (doc, startX, startY, width, height, data, title) => {
    let maxVal = 0;
    data.forEach(d => { if (d.val1 > maxVal) maxVal = d.val1; if (d.val2 && d.val2 > maxVal) maxVal = d.val2; });
    maxVal = maxVal * 1.2;

    doc.setFontSize(9); doc.setFont('helvetica', 'bold');
    doc.text(title, startX + width / 2, startY - 5, { align: 'center' });
    doc.setDrawColor(150); doc.setLineWidth(0.5);
    doc.line(startX, startY, startX, startY + height); doc.line(startX, startY + height, startX + width, startY + height);

    const barGroupWidth = width / data.length;
    const barWidth = (barGroupWidth * 0.6) / (data[0].val2 ? 2 : 1);

    data.forEach((d, i) => {
      const groupX = startX + (i * barGroupWidth) + (barGroupWidth * 0.2);
      
      const h1 = (d.val1 / maxVal) * height;
      doc.setFillColor(50, 50, 50);
      doc.rect(groupX, startY + height - h1, barWidth, h1, 'F');
      doc.setFontSize(6); doc.setTextColor(0);
      doc.text(formatNum(d.val1), groupX + barWidth/2, startY + height - h1 - 2, { align: 'center' });

      if (d.val2) {
        const h2 = (d.val2 / maxVal) * height;
        doc.setFillColor(200, 200, 200);
        doc.rect(groupX + barWidth + 1, startY + height - h2, barWidth, h2, 'F');
        doc.text(formatNum(d.val2), groupX + barWidth + 1 + barWidth/2, startY + height - h2 - 2, { align: 'center' });
      }

      doc.setFontSize(7); doc.text(d.label.substring(0, 8), groupX + barWidth, startY + height + 4, { align: 'center' });
    });
  };

  const generateSmartPDF = (data, action = 'save') => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(0);
    doc.text('MEDIOCARE PHARMACEUTICALS LTD', pageWidth / 2, 20, { align: 'center' });
    doc.setFontSize(12);
    doc.text(`${data.branchName.toUpperCase()} — STOCK CONTROL & FINANCIAL REPORT`, pageWidth / 2, 28, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(`Period: ${data.periodStart} to ${data.periodEnd}`, pageWidth / 2, 34, { align: 'center' });

    let narrative = [];
    const totalVar = data.results.salesVariance;
    if (totalVar > 0) {
      const sortedStaff = [...data.staff].sort((a, b) => (b.actual - (b.system - b.credit)) - (a.actual - (a.system - a.credit)));
      const topDriver1 = sortedStaff[0] ? `${sortedStaff[0].name} (${Math.round(((sortedStaff[0].actual - (sortedStaff[0].system - sortedStaff[0].credit)) / totalVar) * 100)}%)` : '';
      const topDriver2 = sortedStaff[1] ? `${sortedStaff[1].name} (${Math.round(((sortedStaff[1].actual - (sortedStaff[1].system - sortedStaff[1].credit)) / totalVar) * 100)}%)` : '';
      
      narrative.push(`• Positive Sales Variance: Ksh ${formatKsh(totalVar)} (Unrecorded cash/transactions).`);
      if(topDriver1) narrative.push(`• Variance Drivers: ${topDriver1}, ${topDriver2}.`);
      narrative.push(`• The positive sales variance was applied to offset the stock shortage, leaving a residual stock loss of Ksh ${formatKsh(data.results.residualStockLoss)}.`);
    } else if (totalVar < 0) {
      narrative.push(`• Negative Sales Variance: Ksh ${formatKsh(Math.abs(totalVar))} (System sales exceeded actual cash). Requires investigation.`);
    }
    if (data.debtResults.netDebtReduction > 0) narrative.push(`• Debt reduced by Ksh ${formatKsh(data.debtResults.netDebtReduction)} (${data.debtResults.debtReductionPercentage?.toFixed(2)}%) to Ksh ${formatKsh(data.debtResults.adjustedClosingDebt)}.`);
    else narrative.push(`• ADVERSE: Debt increased by Ksh ${formatKsh(Math.abs(data.debtResults.netDebtReduction))}.`);

    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('1. Executive Summary', 14, 45);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    let summaryY = 52;
    narrative.forEach(text => {
      const splitText = doc.splitTextToSize(text, pageWidth - 28);
      doc.text(splitText, 14, summaryY); summaryY += (splitText.length * 5) + 2;
    });

    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('2. Stock Position & Offset', 14, summaryY + 5);
    autoTable(doc, {
      startY: summaryY + 10,
      head: [['Item', 'Ksh', 'Remarks']],
      body: [
        ['Stock before stock take', formatKsh(data.openingStock), 'Opening'],
        ['Stock after stock take', formatKsh(data.physicalStock), 'Physical'],
        ['Gross Stock Variance', formatKsh(data.results.grossStockVariance), 'Difference'],
        ['Less: Positive Sales Offset', `(${formatKsh(data.results.salesOffset)})`, 'Transferred from sales'],
        ['Residual Stock Loss', formatKsh(data.results.residualStockLoss), 'Added to debt'],
      ],
      theme: 'grid', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 }
    });

    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('3. Sales Performance Analysis', 14, doc.lastAutoTable.finalY + 10);
    const salesBody = data.staff.map(s => {
      const adjSys = s.system - s.credit;
      return [s.name, formatKsh(s.actual), formatKsh(s.system), formatKsh(s.credit), formatKsh(adjSys), formatKsh(s.actual - adjSys)];
    });
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15,
      head: [['Staff', 'Actual', 'System', 'Credit', 'Adj. System', 'Variance']],
      body: salesBody,
      theme: 'striped', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 },
      didParseCell: function (data) {
        if (data.section === 'body' && data.column.index === 5 && data.cell.text[0].includes('-')) data.cell.styles.textColor = [192, 57, 43];
      }
    });

    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('4. Branch Account Debt Movement', 14, doc.lastAutoTable.finalY + 10);
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15,
      head: [['Position', 'Date', 'Ksh']],
      body: [
        ['Opening Debt', data.openingDebtDate, `(${formatKsh(data.openingDebt)})`],
        ['Original Closing Debt', data.closingDebtDate, `(${formatKsh(data.originalClosingDebt)})`],
        ['Gross Debt Reduction', '-', formatKsh(data.debtResults.grossDebtReduction)],
        ['Add: Residual Stock Loss', '-', formatKsh(data.results.residualStockLoss)],
        ['Adjusted Closing Debt', '-', `(${formatKsh(data.debtResults.adjustedClosingDebt)})`],
        ['Net Debt Reduction', '-', formatKsh(data.debtResults.netDebtReduction)],
      ],
      theme: 'grid', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 }
    });

    doc.addPage();
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.text('5. Graphical Analysis', 14, 20);
    const chartData = data.staff.slice(0, 6).map(s => ({ label: s.name, val1: s.actual, val2: s.system - s.credit }));
    if(chartData.length > 0) drawBarChart(doc, 20, 40, 170, 60, chartData, 'Actual vs Adjusted System Sales');

    drawBarChart(doc, 20, 130, 80, 50, [
      { label: 'Stock Loss', val1: data.results.grossStockShortage },
      { label: 'Sales Offset', val1: data.results.salesOffset },
      { label: 'Residual', val1: data.results.residualStockLoss }
    ], 'Stock Loss Reconciliation');

    drawBarChart(doc, 110, 130, 80, 50, [
      { label: 'Opening', val1: data.openingDebt },
      { label: 'Adj Close', val1: data.debtResults.adjustedClosingDebt }
    ], 'Debt Movement');

    if (action === 'view') window.open(doc.output('bloburl'), '_blank');
    else doc.save(`${data.branchName}_Report.pdf`);
  };

  const handleGenerateHistoryPDF = (report, action) => {
    const oStk = report.stock_takes?.[0]?.opening_stock || 0;
    const pStk = report.stock_takes?.[0]?.physical_stock || 0;
    const oDebt = report.debt_records?.[0]?.opening_debt || 0;
    const cDebt = report.debt_records?.[0]?.original_closing_debt || 0;
    
    const staffData = (report.sales_records || []).map(sr => ({
      name: sr.salespeople?.name || '', actual: sr.actual_sales || 0, system: sr.system_sales || 0, credit: sr.credit_sales || 0
    }));
    const tAct = staffData.reduce((s, x) => s + x.actual, 0);
    const tSys = staffData.reduce((s, x) => s + x.system, 0);
    const tCre = staffData.reduce((s, x) => s + x.credit, 0);

    const results = calculateStockAndSales(oStk, pStk, tAct, tSys - tCre);
    const debtResults = calculateDebt(oDebt, cDebt, results.residualStockLoss);

    generateSmartPDF({ 
      branchName: report.branches?.name || 'Unknown', periodStart: report.period_start, periodEnd: report.period_end,
      openingStock: oStk, physicalStock: pStk, openingDebt: oDebt, originalClosingDebt: cDebt,
      openingDebtDate: report.debt_records?.[0]?.opening_debt_date || 'N/A', closingDebtDate: report.debt_records?.[0]?.closing_debt_date || 'N/A',
      results, debtResults, staff: staffData 
    }, action);
  };

  // --- BUILD LIVE PREVIEW DATA ---
  const buildLivePreviewData = () => {
    return { 
      branchName, periodStart, periodEnd, openingStock: num(openingStock), physicalStock: num(physicalStock),
      openingDebt: num(openingDebt), originalClosingDebt: num(originalClosingDebt), 
      openingDebtDate, closingDebtDate, results: stockAndSalesResults, debtResults, 
      staff: staff.map(s => ({ name: s.name, actual: num(s.actual), system: num(s.system), credit: num(s.credit) }))
    };
  };

  // --- BUILD HISTORY PREVIEW DATA ---
  const buildHistoryPreviewData = (report) => {
    const oStk = report.stock_takes?.[0]?.opening_stock || 0;
    const pStk = report.stock_takes?.[0]?.physical_stock || 0;
    const oDebt = report.debt_records?.[0]?.opening_debt || 0;
    const cDebt = report.debt_records?.[0]?.original_closing_debt || 0;
    const staffData = (report.sales_records || []).map(sr => ({
      name: sr.salespeople?.name || '', actual: sr.actual_sales || 0, system: sr.system_sales || 0, credit: sr.credit_sales || 0
    }));
    const tAct = staffData.reduce((s, x) => s + x.actual, 0);
    const tSys = staffData.reduce((s, x) => s + x.system, 0);
    const tCre = staffData.reduce((s, x) => s + x.credit, 0);

    const results = calculateStockAndSales(oStk, pStk, tAct, tSys - tCre);
    const debtResults = calculateDebt(oDebt, cDebt, results.residualStockLoss);

    return { 
      branchName: report.branches?.name || 'Unknown', periodStart: report.period_start, periodEnd: report.period_end,
      openingStock: oStk, physicalStock: pStk, openingDebt: oDebt, originalClosingDebt: cDebt,
      openingDebtDate: report.debt_records?.[0]?.opening_debt_date || 'N/A', closingDebtDate: report.debt_records?.[0]?.closing_debt_date || 'N/A',
      results, debtResults, staff: staffData 
    };
  };

  // --- RENDER DOCUMENT VIEWER ---
  const renderDocumentViewer = (data) => {
    const narrative = [];
    if (data.results.salesVariance > 0) {
      const sortedStaff = [...data.staff].sort((a, b) => (b.actual - (b.system - b.credit)) - (a.actual - (a.system - a.credit)));
      const top1 = sortedStaff[0] ? `${sortedStaff[0].name} (${Math.round(((sortedStaff[0].actual - (sortedStaff[0].system - sortedStaff[0].credit)) / data.results.salesVariance) * 100)}%)` : '';
      narrative.push(`Positive Sales Variance of Ksh ${formatKsh(data.results.salesVariance)} indicates unrecorded cash/timing differences.`);
      if (top1) narrative.push(`Major variance drivers include ${top1}.`);
      narrative.push(`The positive variance offsets the stock shortage, leaving a residual loss of Ksh ${formatKsh(data.results.residualStockLoss)}.`);
    } else if (data.results.salesVariance < 0) {
      narrative.push(`Negative Sales Variance of Ksh ${formatKsh(Math.abs(data.results.salesVariance))} indicates system sales exceeded actual cash collected.`);
    }
    if (data.debtResults.netDebtReduction > 0) narrative.push(`Branch debt decreased by Ksh ${formatKsh(data.debtResults.netDebtReduction)} to a closing balance of Ksh ${formatKsh(data.debtResults.adjustedClosingDebt)}.`);
    else narrative.push(`ADVERSE: Branch debt increased by Ksh ${formatKsh(Math.abs(data.debtResults.netDebtReduction))}.`);

    return (
      <div style={{ backgroundColor: '#fff', padding: '40px', borderRadius: '8px', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', maxWidth: '800px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        
        {/* HEADER */}
        <div style={{ textAlign: 'center', borderBottom: '2px solid #333', paddingBottom: '20px', marginBottom: '20px' }}>
          <h1 style={{ margin: 0, fontSize: '24px', color: '#000' }}>MEDIOCARE PHARMACEUTICALS LTD</h1>
          <h2 style={{ margin: '10px 0', fontSize: '18px', color: '#333' }}>{data.branchName.toUpperCase()} — FINANCIAL REPORT</h2>
          <p style={{ margin: 0, fontSize: '14px', color: '#666' }}>Period: {data.periodStart} to {data.periodEnd}</p>
        </div>

        {/* SECTION 1: EXEC SUMMARY */}
        <h3 style={{ fontSize: '16px', borderBottom: '1px solid #ccc', paddingBottom: '5px' }}>1. Executive Summary</h3>
        <ul style={{ fontSize: '14px', lineHeight: '1.6', color: '#333' }}>
          {narrative.map((text, i) => <li key={i} style={{ marginBottom: '8px' }}>{text}</li>)}
        </ul>

        {/* SECTION 2: STOCK */}
        <h3 style={{ fontSize: '16px', borderBottom: '1px solid #ccc', paddingBottom: '5px', marginTop: '30px' }}>2. Stock Position & Offset</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginTop: '10px' }}>
          <thead><tr style={{ backgroundColor: '#f5f5f5', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: '10px', textAlign: 'left' }}>Item</th><th style={{ padding: '10px', textAlign: 'right' }}>Ksh</th><th style={{ padding: '10px', textAlign: 'left' }}>Remarks</th>
          </tr></thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '10px' }}>Stock before stock take</td><td style={{ padding: '10px', textAlign: 'right' }}>{formatKsh(data.openingStock)}</td><td style={{ padding: '10px' }}>Opening</td></tr>
            <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '10px' }}>Stock after stock take</td><td style={{ padding: '10px', textAlign: 'right' }}>{formatKsh(data.physicalStock)}</td><td style={{ padding: '10px' }}>Physical</td></tr>
            <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '10px', fontWeight: 'bold' }}>Gross Stock Variance</td><td style={{ padding: '10px', textAlign: 'right', fontWeight: 'bold' }}>{formatKsh(data.results.grossStockVariance)}</td><td style={{ padding: '10px' }}>Difference</td></tr>
            <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '10px' }}>Less: Positive Sales Offset</td><td style={{ padding: '10px', textAlign: 'right' }}>({formatKsh(data.results.salesOffset)})</td><td style={{ padding: '10px' }}>Transferred from sales</td></tr>
            <tr style={{ backgroundColor: '#fafafa' }}><td style={{ padding: '10px', fontWeight: 'bold' }}>Residual Stock Loss</td><td style={{ padding: '10px', textAlign: 'right', fontWeight: 'bold', color: '#dc3545' }}>{formatKsh(data.results.residualStockLoss)}</td><td style={{ padding: '10px' }}>Added to debt</td></tr>
          </tbody>
        </table>

        {/* SECTION 3: SALES */}
        <h3 style={{ fontSize: '16px', borderBottom: '1px solid #ccc', paddingBottom: '5px', marginTop: '30px' }}>3. Sales Performance Analysis</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginTop: '10px' }}>
          <thead><tr style={{ backgroundColor: '#f5f5f5', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: '10px', textAlign: 'left' }}>Staff</th><th style={{ padding: '10px', textAlign: 'right' }}>Actual</th><th style={{ padding: '10px', textAlign: 'right' }}>System</th><th style={{ padding: '10px', textAlign: 'right' }}>Credit</th><th style={{ padding: '10px', textAlign: 'right' }}>Adj. System</th><th style={{ padding: '10px', textAlign: 'right' }}>Variance</th>
          </tr></thead>
          <tbody>
            {data.staff.map((s, idx) => {
              const adjSys = s.system - s.credit;
              const variance = s.actual - adjSys;
              return (
                <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '10px' }}>{s.name}</td>
                  <td style={{ padding: '10px', textAlign: 'right' }}>{formatKsh(s.actual)}</td>
                  <td style={{ padding: '10px', textAlign: 'right' }}>{formatKsh(s.system)}</td>
                  <td style={{ padding: '10px', textAlign: 'right' }}>{formatKsh(s.credit)}</td>
                  <td style={{ padding: '10px', textAlign: 'right' }}>{formatKsh(adjSys)}</td>
                  <td style={{ padding: '10px', textAlign: 'right', color: variance < 0 ? '#dc3545' : '#28a745', fontWeight: 'bold' }}>{formatKsh(variance)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* SECTION 4: DEBT */}
        <h3 style={{ fontSize: '16px', borderBottom: '1px solid #ccc', paddingBottom: '5px', marginTop: '30px' }}>4. Branch Account Debt Movement</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginTop: '10px' }}>
          <thead><tr style={{ backgroundColor: '#f5f5f5', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: '10px', textAlign: 'left' }}>Position</th><th style={{ padding: '10px', textAlign: 'left' }}>Date</th><th style={{ padding: '10px', textAlign: 'right' }}>Ksh</th>
          </tr></thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '10px' }}>Opening Debt</td><td style={{ padding: '10px' }}>{data.openingDebtDate}</td><td style={{ padding: '10px', textAlign: 'right' }}>({formatKsh(data.openingDebt)})</td></tr>
            <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '10px' }}>Original Closing Debt</td><td style={{ padding: '10px' }}>{data.closingDebtDate}</td><td style={{ padding: '10px', textAlign: 'right' }}>({formatKsh(data.originalClosingDebt)})</td></tr>
            <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '10px' }}>Gross Debt Reduction</td><td style={{ padding: '10px' }}>-</td><td style={{ padding: '10px', textAlign: 'right' }}>{formatKsh(data.debtResults.grossDebtReduction)}</td></tr>
            <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '10px' }}>Add: Residual Stock Loss</td><td style={{ padding: '10px' }}>-</td><td style={{ padding: '10px', textAlign: 'right' }}>{formatKsh(data.results.residualStockLoss)}</td></tr>
            <tr style={{ borderBottom: '1px solid #eee', backgroundColor: '#fafafa' }}><td style={{ padding: '10px', fontWeight: 'bold' }}>Adjusted Closing Debt</td><td style={{ padding: '10px' }}>-</td><td style={{ padding: '10px', textAlign: 'right', fontWeight: 'bold' }}>({formatKsh(data.debtResults.adjustedClosingDebt)})</td></tr>
            <tr style={{ backgroundColor: '#eef2f5' }}><td style={{ padding: '10px', fontWeight: 'bold' }}>Net Debt Reduction</td><td style={{ padding: '10px' }}>-</td><td style={{ padding: '10px', textAlign: 'right', fontWeight: 'bold', color: '#28a745' }}>{formatKsh(data.debtResults.netDebtReduction)}</td></tr>
          </tbody>
        </table>

      </div>
    );
  };

  // --- UI ---
  if (authLoading) return <div style={{ padding: '50px', textAlign: 'center' }}>Loading System...</div>;

  if (!session) {
    return (
      <div style={{ maxWidth: '400px', margin: '100px auto', fontFamily: 'system-ui', padding: '30px', border: '1px solid #ddd', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
        <h2 style={{ textAlign: 'center', marginBottom: '20px' }}>Mediocare Login</h2>
        <form onSubmit={async (e) => {
          e.preventDefault(); setAuthError('');
          const { error } = isSignUp ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password });
          if (error) setAuthError(error.message);
          else if (isSignUp) alert('Check your email for the confirmation link!');
        }}>
          {authError && <p style={{ color: 'red', fontSize: '14px' }}>{authError}</p>}
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '15px', border: '1px solid #ccc', borderRadius: '4px' }} />
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '20px', border: '1px solid #ccc', borderRadius: '4px' }} />
          <button type="submit" style={{ width: '100%', padding: '12px', backgroundColor: '#000', color: '#fff', border: 'none', borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer' }}>{isSignUp ? 'Sign Up' : 'Log In'}</button>
        </form>
        <p style={{ textAlign: 'center', marginTop: '20px', cursor: 'pointer', color: '#0070f3', fontSize: '14px' }} onClick={() => setIsSignUp(!isSignUp)}>{isSignUp ? 'Already have an account? Log In' : 'Need an account? Sign Up'}</p>
      </div>
    );
  }

  return (
    <main style={{ maxWidth: '1200px', margin: '40px auto', fontFamily: 'system-ui', padding: '0 20px' }}>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #333', paddingBottom: '10px', marginBottom: '20px' }}>
        <div>
          <h1 style={{ margin: 0 }}>Mediocare System</h1>
          <span style={{ fontSize: '12px', color: '#666' }}>Logged in as: {session.user.email}</span>
        </div>
        <div>
          <button onClick={() => { setActiveTab('dashboard'); resetForm(); }} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'dashboard' ? '#333' : '#eee', color: activeTab === 'dashboard' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold' }}>Dashboard</button>
          <button onClick={() => { setActiveTab('create'); resetForm(); }} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'create' ? '#333' : '#eee', color: activeTab === 'create' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>New Report</button>
          <button onClick={() => setActiveTab('history')} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'history' ? '#333' : '#eee', color: activeTab === 'history' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>History</button>
          <button onClick={() => setActiveTab('consolidated')} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'consolidated' ? '#333' : '#eee', color: activeTab === 'consolidated' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>Consolidated</button>
          <button onClick={() => supabase.auth.signOut()} style={{ padding: '10px 20px', backgroundColor: '#ff4d4f', color: '#fff', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>Logout</button>
        </div>
      </div>

      {activeTab === 'dashboard' && (
        <div>
          <h2 style={{ marginBottom: '20px' }}>Company Overview</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '20px', marginBottom: '30px' }}>
            <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', borderLeft: '5px solid #333' }}>
              <p style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#666', fontWeight: 'bold' }}>Total Branches</p>
              <h1 style={{ margin: 0, fontSize: '32px' }}>{dashboardStats.totalBranches}</h1>
            </div>
            <div style={{ padding: '20px', backgroundColor: '#fff3cd', borderRadius: '8px', borderLeft: '5px solid #ff9800' }}>
              <p style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#666', fontWeight: 'bold' }}>Pending Reports</p>
              <h1 style={{ margin: 0, fontSize: '32px', color: '#ff9800' }}>{dashboardStats.pendingReports}</h1>
            </div>
            <div style={{ padding: '20px', backgroundColor: '#f8d7da', borderRadius: '8px', borderLeft: '5px solid #dc3545' }}>
              <p style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#666', fontWeight: 'bold' }}>Total Stock Loss</p>
              <h1 style={{ margin: 0, fontSize: '28px', color: '#dc3545' }}>Ksh {formatKsh(dashboardStats.totalStockLoss)}</h1>
            </div>
            <div style={{ padding: '20px', backgroundColor: '#d4edda', borderRadius: '8px', borderLeft: '5px solid #28a745' }}>
              <p style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#666', fontWeight: 'bold' }}>Total Adjusted Debt</p>
              <h1 style={{ margin: 0, fontSize: '28px', color: '#28a745' }}>Ksh {formatKsh(dashboardStats.totalAdjustedDebt)}</h1>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'create' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h2 style={{ margin: 0 }}>{editingReportId ? 'Edit Draft Report' : 'Create New Report'}</h2>
            {editingReportId && <span style={{ color: '#ff9800', fontWeight: 'bold' }}>Editing Mode</span>}
          </div>

          <div style={{ display: 'flex', gap: '20px', marginBottom: '20px' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Branch</label>
              <select value={selectedBranch} onChange={(e) => setSelectedBranch(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }}>
                <option value="">-- Choose Branch --</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Period Start</label>
              <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Period End</label>
              <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            <div>
              <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', marginBottom: '20px', border: '1px solid #ddd' }}>
                <h3 style={{ marginTop: 0 }}>1. Financial Data</h3>
                <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Opening Stock (Ksh)</label>
                <input type="number" value={openingStock} onChange={e => setOpeningStock(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Physical Stock (Ksh)</label>
                <input type="number" value={physicalStock} onChange={e => setPhysicalStock(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                
                <div style={{ display: 'flex', gap: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Opening Debt Date</label>
                    <input type="date" value={openingDebtDate} onChange={e => setOpeningDebtDate(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Opening Debt (Ksh)</label>
                    <input type="number" value={openingDebt} onChange={e => setOpeningDebt(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Closing Debt Date</label>
                    <input type="date" value={closingDebtDate} onChange={e => setClosingDebtDate(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Original Closing Debt (Ksh)</label>
                    <input type="number" value={originalClosingDebt} onChange={e => setOriginalClosingDebt(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', marginBottom: '20px', border: '1px solid #ddd' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                  <h3 style={{ margin: 0 }}>2. Salespeople</h3>
                  <div>
                    <label style={{ padding: '8px 12px', backgroundColor: '#4caf50', color: '#fff', borderRadius: '4px', cursor: 'pointer', fontSize: '14px', marginRight: '10px' }}>
                      Import CSV
                      <input type="file" accept=".csv" onChange={handleCSVUpload} style={{ display: 'none' }} />
                    </label>
                    <button onClick={() => setStaff([...staff, { name: '', actual: '', system: '', credit: '' }])} style={{ padding: '8px 12px', cursor: 'pointer', backgroundColor: '#0070f3', color: '#fff', border: 'none', borderRadius: '4px' }}>+ Add Row</button>
                  </div>
                </div>
                
                {staff.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: '5px', marginBottom: '10px', alignItems: 'flex-end' }}>
                    <div style={{ flex: 2 }}>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold' }}>Name</label>
                      <input type="text" value={s.name} onChange={e => { const n = [...staff]; n[i].name = e.target.value; setStaff(n); }} style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold' }}>Actual</label>
                      <input type="number" value={s.actual} onChange={e => { const n = [...staff]; n[i].actual = e.target.value; setStaff(n); }} style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold' }}>System</label>
                      <input type="number" value={s.system} onChange={e => { const n = [...staff]; n[i].system = e.target.value; setStaff(n); }} style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold' }}>Credit</label>
                      <input type="number" value={s.credit} onChange={e => { const n = [...staff]; n[i].credit = e.target.value; setStaff(n); }} style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
                    </div>
                    <button onClick={() => setStaff(staff.filter((_, idx) => idx !== i))} style={{ padding: '8px', backgroundColor: '#ff4d4f', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>X</button>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button onClick={handleSave} disabled={isSaving} style={{ flex: 1, padding: '15px', backgroundColor: editingReportId ? '#ff9800' : '#0070f3', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                  {isSaving ? 'Saving...' : editingReportId ? 'Update Draft' : 'Save to Database'}
                </button>
                <button onClick={() => setViewingReport(buildLivePreviewData())} style={{ flex: 1, padding: '15px', backgroundColor: '#000', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                  Preview Report
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'history' && (
        <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', border: '1px solid #ddd' }}>
          <h2 style={{ marginTop: 0 }}>Saved Reports</h2>
          {isLoadingData ? <p>Loading...</p> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #ddd', backgroundColor: '#f5f5f5' }}>
                  <th style={{ padding: '10px' }}>Date</th>
                  <th style={{ padding: '10px' }}>Branch</th>
                  <th style={{ padding: '10px' }}>Period</th>
                  <th style={{ padding: '10px' }}>Status</th>
                  <th style={{ padding: '10px' }}>Actions</th>
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
                        <span style={{ padding: '4px 8px', backgroundColor: r.status === 'Approved' ? '#28a745' : '#ff9800', color: '#fff', borderRadius: '12px', fontSize: '12px', fontWeight: 'bold' }}>
                          {r.status}
                        </span>
                      </td>
                      <td style={{ padding: '10px', display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                        <button onClick={() => setViewingReport(buildHistoryPreviewData(r))} style={{ padding: '6px 12px', backgroundColor: '#0070f3', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>View Report</button>
                        
                        {r.status !== 'Approved' && (
                          <>
                            <button onClick={() => handleEditReport(r)} style={{ padding: '6px 12px', backgroundColor: '#ff9800', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Edit</button>
                            <button onClick={() => handleApprove(r.id)} style={{ padding: '6px 12px', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Approve</button>
                          </>
                        )}
                        
                        <button onClick={() => handleGenerateHistoryPDF(r, 'save')} style={{ padding: '6px 12px', backgroundColor: '#333', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Download PDF</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* FULL SCREEN DOCUMENT VIEWER MODAL */}
      {viewingReport && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: '900px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            
            {/* Top Action Bar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '15px' }}>
               <button onClick={() => setViewingReport(null)} style={{ padding: '10px 20px', backgroundColor: '#fff', color: '#333', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>← Back to List</button>
               <button onClick={() => {
                   // We check if viewingReport has an id (it's from history) or not (it's live preview)
                   if(viewingReport.id) {
                       handleGenerateHistoryPDF(historicalReports.find(r => r.id === viewingReport.id), 'save');
                   } else {
                       generateSmartPDF(viewingReport, 'save');
                   }
               }} style={{ padding: '10px 20px', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Download Official PDF</button>
            </div>

            {/* The Document Itself */}
            {renderDocumentViewer(viewingReport)}
            
          </div>
        </div>
      )}

      {activeTab === 'consolidated' && (
        <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', border: '1px solid #ddd' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h2 style={{ margin: 0 }}>Company-Wide Consolidated Report</h2>
          </div>
          
          {isLoadingData ? <p>Aggregating data...</p> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #ddd', backgroundColor: '#eef2f5' }}>
                  <th style={{ padding: '10px' }}>Branch</th>
                  <th style={{ padding: '10px' }}>Status</th>
                  <th style={{ padding: '10px' }}>Period</th>
                  <th style={{ padding: '10px' }}>Opening Debt</th>
                  <th style={{ padding: '10px' }}>Adj. Closing Debt</th>
                  <th style={{ padding: '10px' }}>Net Debt Reduction</th>
                  <th style={{ padding: '10px' }}>Stock Loss</th>
                  <th style={{ padding: '10px' }}>Sales Var.</th>
                </tr>
              </thead>
              <tbody>
                {consolidatedData.map((d, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '10px', fontWeight: 'bold' }}>{d.name}</td>
                    <td style={{ padding: '10px' }}>{d.status}</td>
                    <td style={{ padding: '10px' }}>{d.period}</td>
                    <td style={{ padding: '10px' }}>{formatKsh(d.openingDebt)}</td>
                    <td style={{ padding: '10px' }}>{formatKsh(d.adjClosingDebt)}</td>
                    <td style={{ padding: '10px', color: d.netReduction > 0 ? 'green' : 'red' }}>{formatKsh(d.netReduction)}</td>
                    <td style={{ padding: '10px' }}>{formatKsh(d.stockLoss)}</td>
                    <td style={{ padding: '10px' }}>{formatKsh(d.salesVariance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </main>
  );
}
