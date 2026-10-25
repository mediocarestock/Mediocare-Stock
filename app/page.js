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
  const [userRole, setUserRole] = useState('Viewer'); // Default

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
  
  // Stock Data
  const [prevClosingStock, setPrevClosingStock] = useState('');
  const [openingStock, setOpeningStock] = useState('');
  const [physicalStock, setPhysicalStock] = useState('');
  
  // Debt Data
  const [openingDebt, setOpeningDebt] = useState('');
  const [originalClosingDebt, setOriginalClosingDebt] = useState('');
  
  // Branch Aggregates
  const [branchActual, setBranchActual] = useState('');
  const [branchSystem, setBranchSystem] = useState('');
  const [branchCredit, setBranchCredit] = useState('');

  // Dates
  const today = new Date().toISOString().split('T')[0];
  const [periodStart, setPeriodStart] = useState(today);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [openingDebtDate, setOpeningDebtDate] = useState(today);
  const [closingDebtDate, setClosingDebtDate] = useState(today);
  
  // Salespeople
  const [staff, setStaff] = useState([{ name: '', actual: '', system: '', credit: '' }]);

  // --- HISTORY & CONSOLIDATED STATE ---
  const [historicalReports, setHistoricalReports] = useState([]);
  const [consolidatedData, setConsolidatedData] = useState([]);
  const [isLoadingData, setIsLoadingData] = useState(false);

  // --- AUTH & ROLE LISTENER ---
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) fetchRole(session.user.id);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) fetchRole(session.user.id);
    });
    return () => subscription.unsubscribe();
  }, []);

  const fetchRole = async (userId) => {
    const { data } = await supabase.from('profiles').select('role').eq('id', userId).single();
    if (data && data.role) setUserRole(data.role);
  };

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
  const totalStaffActual = staff.reduce((sum, s) => sum + num(s.actual), 0);
  const totalStaffSystem = staff.reduce((sum, s) => sum + num(s.system), 0);
  const totalStaffCredit = staff.reduce((sum, s) => sum + num(s.credit), 0);

  const finalBranchActual = branchActual !== '' ? num(branchActual) : totalStaffActual;
  const finalBranchSystem = branchSystem !== '' ? num(branchSystem) : totalStaffSystem;
  const finalBranchCredit = branchCredit !== '' ? num(branchCredit) : totalStaffCredit;

  const adjustedSystemSales = finalBranchSystem - finalBranchCredit;
  
  const stockAndSalesResults = calculateStockAndSales(num(openingStock), num(physicalStock), finalBranchActual, adjustedSystemSales);
  const debtResults = calculateDebt(num(openingDebt), num(originalClosingDebt), stockAndSalesResults.residualStockLoss);
  const branchName = branches.find(b => b.id === selectedBranch)?.name || '';

  // --- SAVE / UPDATE / DELETE DATABASE ---
  const handleSave = async () => {
    if (!selectedBranch) return alert('Please select a branch first.');
    setIsSaving(true);
    try {
      let reportId = editingReportId;
      const reportPayload = { 
        branch_id: selectedBranch, 
        period_start: periodStart, 
        period_end: periodEnd,
        branch_actual_sales: finalBranchActual,
        branch_system_sales: finalBranchSystem,
        branch_credit_sales: finalBranchCredit,
        prev_closing_stock: num(prevClosingStock)
      };

      if (editingReportId) {
        await supabase.from('reports').update(reportPayload).eq('id', editingReportId);
        await supabase.from('stock_takes').delete().eq('report_id', editingReportId);
        await supabase.from('debt_records').delete().eq('report_id', editingReportId);
        await supabase.from('sales_records').delete().eq('report_id', editingReportId);
      } else {
        const { data: reportData, error: reportError } = await supabase.from('reports').insert({ 
          ...reportPayload, status: 'Draft' 
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

  const handleDelete = async (reportId) => {
    if(!confirm("Are you sure you want to delete this Draft? This action cannot be undone.")) return;
    const { error } = await supabase.from('reports').delete().eq('id', reportId);
    if (error) alert("Error deleting: " + error.message);
    else { alert("Draft deleted."); fetchHistory(); }
  };

  const resetForm = () => {
    setEditingReportId(null); setSelectedBranch(''); setOpeningStock(''); setPhysicalStock('');
    setOpeningDebt(''); setOriginalClosingDebt(''); setStaff([{ name: '', actual: '', system: '', credit: '' }]);
    setPeriodStart(today); setPeriodEnd(today);
    setBranchActual(''); setBranchSystem(''); setBranchCredit('');
    setPrevClosingStock('');
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

    setBranchActual(report.branch_actual_sales || '');
    setBranchSystem(report.branch_system_sales || '');
    setBranchCredit(report.branch_credit_sales || '');
    setPrevClosingStock(report.prev_closing_stock || '');

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
      id, status, branch_actual_sales, branch_system_sales, branch_credit_sales, stock_takes(opening_stock, physical_stock), debt_records(opening_debt, original_closing_debt)
    `);
    if (data) {
      let pending = 0, tStockLoss = 0, tAdjDebt = 0;
      data.forEach(r => {
        if (r.status !== 'Approved') pending++;
        
        const tAct = r.branch_actual_sales || 0;
        const tSys = r.branch_system_sales || 0;
        const tCre = r.branch_credit_sales || 0;
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
      id, period_start, period_end, branch_id, status, branch_actual_sales, branch_system_sales, branch_credit_sales, branches(name), stock_takes(opening_stock, physical_stock), debt_records(opening_debt, original_closing_debt)
    `).order('created_at', { ascending: false });

    if (data) {
      const grouped = {};
      data.forEach(r => {
        if (!grouped[r.branch_id] || r.status === 'Approved') {
          const tAct = r.branch_actual_sales || 0;
          const tSys = r.branch_system_sales || 0;
          const tCre = r.branch_credit_sales || 0;
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

  // --- SHARED DATA BUILDER ---
  const buildReportData = (isHistory = false, report = null) => {
    if (isHistory) {
      const oStk = report.stock_takes?.[0]?.opening_stock || 0;
      const pStk = report.stock_takes?.[0]?.physical_stock || 0;
      const oDebt = report.debt_records?.[0]?.opening_debt || 0;
      const cDebt = report.debt_records?.[0]?.original_closing_debt || 0;
      
      const staffData = (report.sales_records || []).map(sr => ({
        name: sr.salespeople?.name || '', actual: sr.actual_sales || 0, system: sr.system_sales || 0, credit: sr.credit_sales || 0
      }));
      
      const tAct = report.branch_actual_sales || staffData.reduce((s, x) => s + x.actual, 0);
      const tSys = report.branch_system_sales || staffData.reduce((s, x) => s + x.system, 0);
      const tCre = report.branch_credit_sales || staffData.reduce((s, x) => s + x.credit, 0);

      const results = calculateStockAndSales(oStk, pStk, tAct, tSys - tCre);
      const debtResults = calculateDebt(oDebt, cDebt, results.residualStockLoss);

      return {
        branchName: report.branches?.name || 'Unknown',
        periodStart: report.period_start, periodEnd: report.period_end,
        openingStock: oStk, physicalStock: pStk, openingDebt: oDebt, originalClosingDebt: cDebt,
        openingDebtDate: report.debt_records?.[0]?.opening_debt_date || 'N/A',
        closingDebtDate: report.debt_records?.[0]?.closing_debt_date || 'N/A',
        results, debtResults, staff: staffData,
        branchActual: tAct, branchSystem: tSys, branchCredit: tCre,
        previousStock: report.prev_closing_stock > 0 ? { amount: report.prev_closing_stock, date: 'Manual Entry' } : null
      };
    } else {
      return {
        branchName, periodStart, periodEnd,
        openingStock: num(openingStock), physicalStock: num(physicalStock),
        openingDebt: num(openingDebt), originalClosingDebt: num(originalClosingDebt),
        openingDebtDate, closingDebtDate, results: stockAndSalesResults, debtResults,
        staff: staff.map(s => ({ name: s.name || 'Unnamed', actual: num(s.actual), system: num(s.system), credit: num(s.credit) })),
        branchActual: finalBranchActual, branchSystem: finalBranchSystem, branchCredit: finalBranchCredit,
        previousStock: num(prevClosingStock) > 0 ? { amount: num(prevClosingStock), date: 'Manual Entry' } : null
      };
    }
  };

  // --- SMART NOTES & PROGRESS ALGORITHM ---
  const generateNotes = (data) => {
    let notes = [];
    
    // 1. Sales & Stock Offset
    if (data.results.salesVariance > 0 && data.results.grossStockShortage > 0) {
      if (data.results.remainingSalesSurplus > 0) {
        notes.push(`The branch recorded a positive sales variance (surplus) of Ksh ${formatKsh(data.results.salesVariance)}. This surplus was applied to fully offset the stock shortage of Ksh ${formatKsh(data.results.grossStockShortage)}, leaving an unreconciled sales surplus of Ksh ${formatKsh(data.results.remainingSalesSurplus)}.`);
      } else {
        notes.push(`The branch recorded a positive sales variance of Ksh ${formatKsh(data.results.salesVariance)}. This was applied against the stock shortage of Ksh ${formatKsh(data.results.grossStockShortage)}, reducing the unreconciled residual stock loss to Ksh ${formatKsh(data.results.residualStockLoss)}.`);
      }
    } else if (data.results.salesVariance > 0 && data.results.grossStockShortage === 0) {
      notes.push(`The branch recorded a positive sales variance of Ksh ${formatKsh(data.results.salesVariance)} with no stock shortage. This represents unrecorded cash or timing differences.`);
    } else if (data.results.salesVariance <= 0 && data.results.grossStockShortage > 0) {
      notes.push(`No positive sales variance is available to offset the stock shortage. The branch recorded a negative sales variance (cash shortage) of Ksh ${formatKsh(Math.abs(data.results.salesVariance))}, resulting in a full residual stock loss of Ksh ${formatKsh(data.results.residualStockLoss)}.`);
    }

    // 2. Unallocated Gap
    const unallocActual = data.branchActual - data.staff.reduce((sum, s) => sum + s.actual, 0);
    if (Math.abs(unallocActual) > 0) {
      notes.push(`An unallocated sales gap of Ksh ${formatKsh(unallocActual)} exists between the branch aggregate actual sales and the sum of individual salesperson actual sales. This requires further investigation.`);
    }

    // 3. Debt Adjustment
    if (data.results.residualStockLoss > 0) {
      notes.push(`The residual stock loss of Ksh ${formatKsh(data.results.residualStockLoss)} was added to the closing debt, increasing the original closing debt of Ksh ${formatKsh(data.originalClosingDebt)} to an adjusted closing debt of Ksh ${formatKsh(data.debtResults.adjustedClosingDebt)}.`);
    } else {
      notes.push(`No residual stock loss was added to the debt. The adjusted closing debt remains at Ksh ${formatKsh(data.debtResults.adjustedClosingDebt)}.`);
    }

    // 4. STOCK vs DEBT PROGRESS ALGORITHM
    if (data.previousStock && data.previousStock.amount !== null) {
      const prevStockVal = data.previousStock.amount;
      const currStockVal = data.physicalStock;
      const stockChange = currStockVal - prevStockVal;
      const debtChange = data.debtResults.adjustedClosingDebt - data.openingDebt;

      let stockTrend = stockChange > 0 ? `increased by Ksh ${formatKsh(stockChange)}` : stockChange < 0 ? `reduced by Ksh ${formatKsh(Math.abs(stockChange))}` : 'remained stagnant';
      let debtTrend = debtChange > 0 ? `increased by Ksh ${formatKsh(Math.abs(debtChange))}` : debtChange < 0 ? `reduced by Ksh ${formatKsh(Math.abs(debtChange))}` : 'remained stagnant';

      notes.push(`-- BRANCH PROGRESS ANALYSIS --`);
      notes.push(`Compared to the previous closing stock of Ksh ${formatKsh(prevStockVal)}, the current closing stock has ${stockTrend}. Over the same period, the adjusted branch debt has ${debtTrend} (Opening: Ksh ${formatKsh(data.openingDebt)} -> Adjusted Closing: Ksh ${formatKsh(data.debtResults.adjustedClosingDebt)}).`);

      if (stockChange >= 0 && debtChange < 0) {
        notes.push(`DIAGNOSIS: EXCELLENT PROGRESS. The branch successfully increased its physical stock holding while simultaneously reducing its debt to Head Office. This indicates strong sales, good collections, and proper capital management.`);
      } else if (stockChange <= 0 && debtChange < 0) {
        notes.push(`DIAGNOSIS: HEALTHY PROGRESS. The branch liquidated existing stock and used the proceeds to reduce its debt. This is a standard healthy trading cycle.`);
      } else if (stockChange >= 0 && debtChange >= 0) {
        notes.push(`DIAGNOSIS: CONCERNING. Both stock and debt have increased. While the branch is stocking up, it is not remitting enough cash to Head Office relative to the value it is consuming. Investigate credit sales and collection rates.`);
      } else if (stockChange < 0 && debtChange >= 0) {
        notes.push(`DIAGNOSIS: CRITICAL RISK. The branch's stock has depleted, yet its debt has increased. This indicates that stock is leaving the branch without corresponding cash remittances. This is a major red flag for unrecorded sales, pilferage, or significant uncollected credit sales. Immediate investigation is required.`);
      }
    }

    return notes;
  };

  // --- PDF ENGINE ---
  const drawBarChart = (doc, startX, startY, width, height, data, title) => {
    let maxVal = 0;
    data.forEach(d => { if (d.val1 > maxVal) maxVal = d.val1; if (d.val2 && d.val2 > maxVal) maxVal = d.val2; });
    maxVal = maxVal * 1.2 || 100;

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

  const generatePDF = (data, action = 'save') => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    
    // HEADER
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(0);
    doc.text('MEDIOCARE PHARMACEUTICALS LTD', pageWidth / 2, 20, { align: 'center' });
    doc.setFontSize(12);
    doc.text(`${data.branchName.toUpperCase()} — STOCK CONTROL & FINANCIAL REPORT`, pageWidth / 2, 28, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(`Period: ${data.periodStart} to ${data.periodEnd}`, pageWidth / 2, 34, { align: 'center' });

    // 1. EXEC SUMMARY & NOTES
    const notes = generateNotes(data);
    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('1. Executive Summary & Diagnostic Notes', 14, 45);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    let summaryY = 52;
    notes.forEach(text => {
      if (text.startsWith('--')) {
        doc.setFont('helvetica', 'bold');
        doc.text(text, 14, summaryY);
        summaryY += 5;
        doc.setFont('helvetica', 'normal');
      } else {
        const splitText = doc.splitTextToSize(`• ${text}`, pageWidth - 28);
        doc.text(splitText, 14, summaryY); 
        summaryY += (splitText.length * 5) + 2;
      }
    });

    // 2. STOCK POSITION
    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('2. Stock Position and Offset', 14, summaryY + 5);
    
    const stockTableBody = [];
    if (data.previousStock && data.previousStock.amount !== null) {
      stockTableBody.push(['Previous Closing Stock', formatKsh(data.previousStock.amount), 'Manual Baseline']);
    }
    stockTableBody.push(
      ['Stock before stock take', formatKsh(data.openingStock), 'Opening (Book)'],
      ['Stock after stock take', formatKsh(data.physicalStock), 'Physical (Closing)'],
      ['Gross Stock Variance', formatKsh(data.results.grossStockVariance), `${(data.results.stockVariancePercentage || 0).toFixed(2)}% of opening`],
      ['Positive Sales Variance', formatKsh(data.results.salesVariance), 'Credit-adjusted'],
      ['Less: Applied to offset', `(${formatKsh(data.results.salesOffset)})`, 'Transferred'],
      ['Residual Stock Loss', formatKsh(data.results.residualStockLoss), 'Added to debt']
    );

    autoTable(doc, {
      startY: summaryY + 10,
      head: [['Item', 'Ksh', 'Remarks']],
      body: stockTableBody,
      theme: 'grid', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 }
    });

    // 3. SALES RECONCILIATION
    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('3. Sales Reconciliation (Credit-Adjusted)', 14, doc.lastAutoTable.finalY + 10);
    
    const salesBody = data.staff.map(s => {
      const adjSys = s.system - s.credit;
      return [s.name, formatKsh(s.actual), formatKsh(s.system), formatKsh(s.credit), formatKsh(adjSys), formatKsh(s.actual - adjSys)];
    });
    
    const unallocActual = data.branchActual - data.staff.reduce((sum, s) => sum + s.actual, 0);
    const unallocSystem = data.branchSystem - data.staff.reduce((sum, s) => sum + s.system, 0);
    const unallocCredit = data.branchCredit - data.staff.reduce((sum, s) => sum + s.credit, 0);
    
    if (unallocActual !== 0 || unallocSystem !== 0 || unallocCredit !== 0) {
      const adjUnalloc = unallocSystem - unallocCredit;
      salesBody.push(['Unallocated', formatKsh(unallocActual), formatKsh(unallocSystem), formatKsh(unallocCredit), formatKsh(adjUnalloc), formatKsh(unallocActual - adjUnalloc)]);
    }

    salesBody.push(['Branch Total', formatKsh(data.branchActual), formatKsh(data.branchSystem), formatKsh(data.branchCredit), formatKsh(data.branchSystem - data.branchCredit), formatKsh(data.results.salesVariance)]);

    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15,
      head: [['Staff', 'Actual Cash', 'System Sales', 'Credit Sales', 'Adj. System', 'Variance']],
      body: salesBody,
      theme: 'striped', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 },
      didParseCell: function (data) {
        if (data.section === 'body' && data.column.index === 5) {
          if (data.cell.text[0].includes('-')) data.cell.styles.textColor = [192, 57, 43];
          else if (data.cell.text[0] !== '-' && data.row.index !== salesBody.length -1) data.cell.styles.textColor = [39, 174, 96];
        }
        if (data.row.index === salesBody.length - 1 || data.cell.text[0] === 'Unallocated') {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fillColor = [240, 240, 240];
        }
      }
    });

    // 4. DEBT POSITION
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
      theme: 'grid', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 },
      didParseCell: function (data) {
        if (data.section === 'body' && data.column.index === 2 && data.row.index === 5) data.cell.styles.textColor = [39, 174, 96];
      }
    });

    // GRAPHS PAGE
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

  // --- CONSOLIDATED MASTER PDF ---
  const generateConsolidatedPDF = () => {
    if(consolidatedData.length === 0) return alert("No data available to consolidate.");
    
    const doc = new jsPDF('landscape');
    const pageWidth = doc.internal.pageSize.getWidth();
    
    // HEADER
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(0);
    doc.text('MEDIOCARE PHARMACEUTICALS LTD', pageWidth / 2, 20, { align: 'center' });
    doc.setFontSize(12);
    doc.text('COMPANY-WIDE CONSOLIDATED FINANCIAL REPORT', pageWidth / 2, 28, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(`Generated on: ${new Date().toLocaleString()} | Base Currency: KES`, pageWidth / 2, 34, { align: 'center' });

    // TOTALS
    const totals = consolidatedData.reduce((acc, curr) => {
      acc.openingDebt += curr.openingDebt; acc.adjClosingDebt += curr.adjClosingDebt;
      acc.netReduction += curr.netReduction; acc.stockLoss += curr.stockLoss;
      acc.salesVariance += curr.salesVariance;
      return acc;
    }, { openingDebt: 0, adjClosingDebt: 0, netReduction: 0, stockLoss: 0, salesVariance: 0 });

    const tableBody = consolidatedData.map(d => [
      d.name, d.period, d.status, formatKsh(d.openingDebt), formatKsh(d.adjClosingDebt), 
      formatKsh(d.netReduction), formatKsh(d.stockLoss), formatKsh(d.salesVariance)
    ]);

    autoTable(doc, {
      startY: 45,
      head: [['Branch', 'Period', 'Status', 'Opening Debt', 'Adj. Closing Debt', 'Net Reduction', 'Stock Loss', 'Sales Var.']],
      body: tableBody,
      foot: [['GRAND TOTALS', '-', '-', formatKsh(totals.openingDebt), formatKsh(totals.adjClosingDebt), formatKsh(totals.netReduction), formatKsh(totals.stockLoss), formatKsh(totals.salesVariance)]],
      theme: 'grid', 
      headStyles: { fillColor: [44, 62, 80] },
      footStyles: { fillColor: [0, 0, 0], textColor: [255, 255, 255], fontStyle: 'bold' },
      styles: { fontSize: 8 }
    });

    // ANALYSIS
    const highestStockLoss = [...consolidatedData].sort((a, b) => b.stockLoss - a.stockLoss)[0];
    const highestSalesVar = [...consolidatedData].sort((a, b) => b.salesVariance - a.salesVariance)[0];
    
    let textY = doc.lastAutoTable.finalY + 10;
    doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(0);
    doc.text('Automated Head Office Analysis:', 14, textY);
    
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    textY += 6;
    doc.text(`• Total Company Stock Loss: Ksh ${formatKsh(totals.stockLoss)}`, 14, textY);
    textY += 5;
    doc.text(`• Highest Stock Loss Branch: ${highestStockLoss.name} (Ksh ${formatKsh(highestStockLoss.stockLoss)})`, 14, textY);
    textY += 5;
    doc.text(`• Highest Sales Variance Branch: ${highestSalesVar.name} (Ksh ${formatKsh(highestSalesVar.salesVariance)})`, 14, textY);

    // CHART
    const chartData = consolidatedData.slice(0, 12).map(d => ({ label: d.name, val1: d.netReduction }));
    if(chartData.length > 0) {
      drawBarChart(doc, 14, textY + 25, pageWidth - 28, 50, chartData, 'Net Debt Reduction by Branch (Positive = Good)');
    }

    doc.save(`Company_Consolidated_Report.pdf`);
  };


  // --- AUTHENTICATION UI ---
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
      
      {/* HEADER NAVIGATION */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #333', paddingBottom: '10px', marginBottom: '20px' }}>
        <div>
          <h1 style={{ margin: 0 }}>Mediocare System</h1>
          <span style={{ fontSize: '12px', color: '#666' }}>Logged in as: {session.user.email} | Role: <strong>{userRole}</strong></span>
        </div>
        <div>
          <button onClick={() => { setActiveTab('dashboard'); resetForm(); }} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'dashboard' ? '#333' : '#eee', color: activeTab === 'dashboard' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold' }}>Dashboard</button>
          <button onClick={() => { setActiveTab('create'); resetForm(); }} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'create' ? '#333' : '#eee', color: activeTab === 'create' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>New Report</button>
          <button onClick={() => setActiveTab('history')} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'history' ? '#333' : '#eee', color: activeTab === 'history' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>History</button>
          <button onClick={() => setActiveTab('consolidated')} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'consolidated' ? '#333' : '#eee', color: activeTab === 'consolidated' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>Consolidated</button>
          <button onClick={() => supabase.auth.signOut()} style={{ padding: '10px 20px', backgroundColor: '#ff4d4f', color: '#fff', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>Logout</button>
        </div>
      </div>

      {/* DASHBOARD TAB */}
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

      {/* CREATE TAB */}
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
            
            {/* LEFT COLUMN: STOCK & DEBT */}
            <div>
              <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', marginBottom: '20px', border: '1px solid #ddd' }}>
                <h3 style={{ marginTop: 0 }}>1. Stock & Debt Core</h3>
                
                <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Previous Closing Stock (Manual)</label>
                    <input type="number" value={prevClosingStock} onChange={e => setPrevClosingStock(e.target.value)} placeholder="e.g. Last month's value" style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px', backgroundColor: '#fff9e6' }} />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Opening Stock (Book Value)</label>
                    <input type="number" value={openingStock} onChange={e => setOpeningStock(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>New Closing Stock (Physical)</label>
                    <input type="number" value={physicalStock} onChange={e => setPhysicalStock(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                </div>
                
                <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Opening Debt Date</label>
                    <input type="date" value={openingDebtDate} onChange={e => setOpeningDebtDate(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Opening Debt (Ksh)</label>
                    <input type="number" value={openingDebt} onChange={e => setOpeningDebt(e.target.value)} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
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

              <div style={{ padding: '20px', backgroundColor: '#eef2f5', borderRadius: '8px', marginBottom: '20px', border: '1px solid #ccc' }}>
                <h3 style={{ marginTop: 0 }}>2. Branch Reconciliation Totals</h3>
                <p style={{ fontSize: '12px', color: '#666', marginTop: '-10px', marginBottom: '10px' }}>Enter Branch Aggregates. (If blank, auto-sums from salespeople).</p>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Branch Actual Sales</label>
                    <input type="number" value={branchActual} onChange={e => setBranchActual(e.target.value)} placeholder={totalStaffActual > 0 ? totalStaffActual.toString() : "0"} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Branch System Sales</label>
                    <input type="number" value={branchSystem} onChange={e => setBranchSystem(e.target.value)} placeholder={totalStaffSystem > 0 ? totalStaffSystem.toString() : "0"} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Branch Credit Sales</label>
                    <input type="number" value={branchCredit} onChange={e => setBranchCredit(e.target.value)} placeholder={totalStaffCredit > 0 ? totalStaffCredit.toString() : "0"} style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                  </div>
                </div>
              </div>
            </div>

            {/* RIGHT COLUMN: SALESPEOPLE */}
            <div>
              <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', marginBottom: '20px', border: '1px solid #ddd' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                  <h3 style={{ margin: 0 }}>3. Individual Salespeople</h3>
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
                <button onClick={() => setViewingReport(buildReportData(false))} style={{ flex: 1, padding: '15px', backgroundColor: '#000', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                  Preview Report
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* HISTORY TAB */}
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
                        <button onClick={() => setViewingReport(buildReportData(true, r))} style={{ padding: '6px 12px', backgroundColor: '#0070f3', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>View Report</button>
                        
                        {r.status !== 'Approved' && (
                          <>
                            <button onClick={() => handleEditReport(r)} style={{ padding: '6px 12px', backgroundColor: '#ff9800', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Edit</button>
                            
                            {userRole === 'Admin' && (
                              <>
                                <button onClick={() => handleApprove(r.id)} style={{ padding: '6px 12px', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Approve</button>
                                <button onClick={() => handleDelete(r.id)} style={{ padding: '6px 12px', backgroundColor: '#dc3545', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Delete</button>
                              </>
                            )}
                          </>
                        )}
                        
                        <button onClick={() => generatePDF(buildReportData(true, r), 'save')} style={{ padding: '6px 12px', backgroundColor: '#333', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Download</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* CONSOLIDATED TAB */}
      {activeTab === 'consolidated' && (
        <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', border: '1px solid #ddd' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h2 style={{ margin: 0 }}>Company-Wide Consolidated Report</h2>
            <button onClick={generateConsolidatedPDF} style={{ padding: '10px 20px', backgroundColor: '#000', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Download Master PDF</button>
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

      {/* FULL SCREEN DOCUMENT VIEWER MODAL (Same as previous) */}
      {viewingReport && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', zIndex: 1000, padding: '40px 20px', overflowY: 'auto' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: '850px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '15px', position: 'sticky', top: 0, zIndex: 10 }}>
               <button onClick={() => setViewingReport(null)} style={{ padding: '12px 24px', backgroundColor: '#fff', color: '#000', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 2px 10px rgba(0,0,0,0.3)' }}>← Back</button>
               <button onClick={() => generatePDF(viewingReport, 'save')} style={{ padding: '12px 24px', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 2px 10px rgba(0,0,0,0.3)' }}>Download PDF</button>
            </div>

            <div style={{ backgroundColor: '#fff', padding: '50px', width: '100%', borderRadius: '4px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', fontFamily: '"Times New Roman", Times, serif', color: '#000' }}>
              
              <div style={{ textAlign: 'center', marginBottom: '30px' }}>
                <h1 style={{ margin: 0, fontSize: '24px', textTransform: 'uppercase', letterSpacing: '1px' }}>Mediocare Pharmaceuticals Ltd</h1>
                <h2 style={{ margin: '10px 0', fontSize: '18px', fontWeight: 'normal' }}>{viewingReport.branchName.toUpperCase()} — STOCK CONTROL & FINANCIAL REPORT</h2>
                <p style={{ margin: 0, fontSize: '14px' }}>Reporting Period: {viewingReport.periodStart} to {viewingReport.periodEnd}</p>
              </div>

              <h3 style={{ fontSize: '16px', borderBottom: '2px solid #000', paddingBottom: '5px', marginTop: '30px' }}>1. Executive Summary & Notes</h3>
              <ul style={{ fontSize: '14px', lineHeight: '1.6', paddingLeft: '20px' }}>
                {generateNotes(viewingReport).map((note, idx) => (
                  note.startsWith('--') ? 
                    <div key={idx} style={{ marginTop: '15px', marginBottom: '5px', fontWeight: 'bold', marginLeft: '-20px' }}>{note}</div> 
                  : 
                    <li key={idx} style={{ marginBottom: '8px' }}>{note}</li>
                ))}
              </ul>

              <h3 style={{ fontSize: '16px', borderBottom: '2px solid #000', paddingBottom: '5px', marginTop: '30px' }}>2. Stock Position and Offset</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', marginTop: '10px' }}>
                <thead><tr style={{ backgroundColor: '#333', color: '#fff' }}>
                  <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #000' }}>Item</th>
                  <th style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>Ksh</th>
                  <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #000' }}>Note</th>
                </tr></thead>
                <tbody>
                  {viewingReport.previousStock && viewingReport.previousStock.amount !== null && (
                    <tr><td style={{ padding: '8px', border: '1px solid #000', fontStyle: 'italic' }}>Previous Closing Stock (Manual)</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000', fontStyle: 'italic' }}>{formatKsh(viewingReport.previousStock.amount)}</td><td style={{ padding: '8px', border: '1px solid #000', fontStyle: 'italic' }}>Baseline</td></tr>
                  )}
                  <tr><td style={{ padding: '8px', border: '1px solid #000' }}>Stock before stock take</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(viewingReport.openingStock)}</td><td style={{ padding: '8px', border: '1px solid #000' }}>Opening (Book)</td></tr>
                  <tr><td style={{ padding: '8px', border: '1px solid #000' }}>Stock after stock take</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(viewingReport.physicalStock)}</td><td style={{ padding: '8px', border: '1px solid #000' }}>Physical (Closing)</td></tr>
                  <tr><td style={{ padding: '8px', border: '1px solid #000', fontWeight: 'bold' }}>Gross Stock Variance</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000', fontWeight: 'bold' }}>{formatKsh(viewingReport.results.grossStockVariance)}</td><td style={{ padding: '8px', border: '1px solid #000' }}>{(viewingReport.results.stockVariancePercentage || 0).toFixed(2)}% of opening</td></tr>
                  <tr><td style={{ padding: '8px', border: '1px solid #000' }}>Sales surplus available</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(viewingReport.results.salesVariance)}</td><td style={{ padding: '8px', border: '1px solid #000' }}>Credit-adjusted</td></tr>
                  <tr><td style={{ padding: '8px', border: '1px solid #000' }}>Less: applied to stock loss</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>({formatKsh(viewingReport.results.salesOffset)})</td><td style={{ padding: '8px', border: '1px solid #000' }}>Full offset</td></tr>
                  <tr><td style={{ padding: '8px', border: '1px solid #000', fontWeight: 'bold' }}>Residual Stock Loss</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000', fontWeight: 'bold', color: '#dc3545' }}>{formatKsh(viewingReport.results.residualStockLoss)}</td><td style={{ padding: '8px', border: '1px solid #000' }}>Added to debt</td></tr>
                </tbody>
              </table>

              <h3 style={{ fontSize: '16px', borderBottom: '2px solid #000', paddingBottom: '5px', marginTop: '30px' }}>3. Sales Reconciliation (Credit-Adjusted)</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', marginTop: '10px' }}>
                <thead><tr style={{ backgroundColor: '#333', color: '#fff' }}>
                  <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #000' }}>Staff</th>
                  <th style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>Actual Cash</th>
                  <th style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>System Sales</th>
                  <th style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>Credit Sales</th>
                  <th style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>Adj. System</th>
                  <th style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>Variance</th>
                </tr></thead>
                <tbody>
                  {viewingReport.staff.map((s, idx) => {
                    const adjSys = s.system - s.credit;
                    const variance = s.actual - adjSys;
                    return (
                      <tr key={idx}>
                        <td style={{ padding: '8px', border: '1px solid #000' }}>{s.name}</td>
                        <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(s.actual)}</td>
                        <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(s.system)}</td>
                        <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(s.credit)}</td>
                        <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(adjSys)}</td>
                        <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000', color: variance < 0 ? '#dc3545' : '#28a745', fontWeight: 'bold' }}>{formatKsh(variance)}</td>
                      </tr>
                    );
                  })}
                  
                  {(() => {
                    const unallocActual = viewingReport.branchActual - viewingReport.staff.reduce((sum, s) => sum + s.actual, 0);
                    const unallocSystem = viewingReport.branchSystem - viewingReport.staff.reduce((sum, s) => sum + s.system, 0);
                    const unallocCredit = viewingReport.branchCredit - viewingReport.staff.reduce((sum, s) => sum + s.credit, 0);
                    if (unallocActual !== 0 || unallocSystem !== 0 || unallocCredit !== 0) {
                      const adjUnalloc = unallocSystem - unallocCredit;
                      return (
                        <tr style={{ backgroundColor: '#fff3cd' }}>
                          <td style={{ padding: '8px', border: '1px solid #000', fontWeight: 'bold' }}>Unallocated</td>
                          <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(unallocActual)}</td>
                          <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(unallocSystem)}</td>
                          <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(unallocCredit)}</td>
                          <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(adjUnalloc)}</td>
                          <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000', color: (unallocActual - adjUnalloc) < 0 ? '#dc3545' : '#28a745', fontWeight: 'bold' }}>{formatKsh(unallocActual - adjUnalloc)}</td>
                        </tr>
                      );
                    }
                    return null;
                  })()}

                  <tr style={{ backgroundColor: '#f0f0f0', fontWeight: 'bold' }}>
                    <td style={{ padding: '8px', border: '1px solid #000' }}>Branch Total</td>
                    <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(viewingReport.branchActual)}</td>
                    <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(viewingReport.branchSystem)}</td>
                    <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(viewingReport.branchCredit)}</td>
                    <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(viewingReport.branchSystem - viewingReport.branchCredit)}</td>
                    <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000', color: viewingReport.results.salesVariance < 0 ? '#dc3545' : '#28a745' }}>{formatKsh(viewingReport.results.salesVariance)}</td>
                  </tr>
                </tbody>
              </table>

              <h3 style={{ fontSize: '16px', borderBottom: '2px solid #000', paddingBottom: '5px', marginTop: '30px' }}>4. Branch Account Debt Movement</h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', marginTop: '10px' }}>
                <thead><tr style={{ backgroundColor: '#333', color: '#fff' }}>
                  <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #000' }}>Position</th>
                  <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #000' }}>Date</th>
                  <th style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>Ksh</th>
                </tr></thead>
                <tbody>
                  <tr><td style={{ padding: '8px', border: '1px solid #000' }}>Opening Debt</td><td style={{ padding: '8px', border: '1px solid #000' }}>{viewingReport.openingDebtDate}</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>({formatKsh(viewingReport.openingDebt)})</td></tr>
                  <tr><td style={{ padding: '8px', border: '1px solid #000' }}>Original Closing Debt</td><td style={{ padding: '8px', border: '1px solid #000' }}>{viewingReport.closingDebtDate}</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>({formatKsh(viewingReport.originalClosingDebt)})</td></tr>
                  <tr><td style={{ padding: '8px', border: '1px solid #000' }}>Gross Debt Reduction</td><td style={{ padding: '8px', border: '1px solid #000' }}>-</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(viewingReport.debtResults.grossDebtReduction)}</td></tr>
                  <tr><td style={{ padding: '8px', border: '1px solid #000' }}>Add: Residual Stock Loss</td><td style={{ padding: '8px', border: '1px solid #000' }}>-</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(viewingReport.results.residualStockLoss)}</td></tr>
                  <tr style={{ backgroundColor: '#f0f0f0' }}><td style={{ padding: '8px', border: '1px solid #000', fontWeight: 'bold' }}>Adjusted Closing Debt</td><td style={{ padding: '8px', border: '1px solid #000' }}>-</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000', fontWeight: 'bold' }}>({formatKsh(viewingReport.debtResults.adjustedClosingDebt)})</td></tr>
                  <tr><td style={{ padding: '8px', border: '1px solid #000', fontWeight: 'bold' }}>Net Debt Reduction</td><td style={{ padding: '8px', border: '1px solid #000' }}>-</td><td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000', fontWeight: 'bold', color: '#28a745' }}>{formatKsh(viewingReport.debtResults.netDebtReduction)}</td></tr>
                </tbody>
              </table>

            </div>
          </div>
        </div>
      )}
    </main>
  );
}
