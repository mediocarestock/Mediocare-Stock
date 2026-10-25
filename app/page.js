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
  const [userRole, setUserRole] = useState('Viewer'); 

  // --- UI STATE ---
  const [activeTab, setActiveTab] = useState('dashboard'); 
  const [branches, setBranches] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [viewingReport, setViewingReport] = useState(null);

  // --- SETTINGS & ADMIN STATE ---
  const [deductCredit, setDeductCredit] = useState(true);
  const [addLossToDebt, setAddLossToDebt] = useState(true);
  const [newBranchName, setNewBranchName] = useState('');
  const [usersList, setUsersList] = useState([]);

  // --- DASHBOARD STATE ---
  const [dashboardStats, setDashboardStats] = useState({
    totalBranches: 17, pendingReports: 0, totalStockLoss: 0, totalAdjustedDebt: 0
  });
  const [chartData, setChartData] = useState({ debtReductions: [], stockLosses: [] });

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

  // Corrective Actions
  const [actions, setActions] = useState([{ finding: '', amount: '', actionRequired: '', responsible: '', deadline: '', status: 'Pending' }]);

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

  const fetchSettings = async () => {
    const { data } = await supabase.from('app_settings').select('*').eq('id', 1).single();
    if (data) {
      setDeductCredit(data.deduct_credit_sales);
      setAddLossToDebt(data.add_residual_loss_to_debt);
    }
  };

  const fetchUsers = async () => {
    const { data } = await supabase.from('profiles').select('*').order('email');
    if (data) setUsersList(data);
  };

  useEffect(() => {
    if (session) {
      fetchSettings();
      supabase.from('branches').select('*').order('name').then(({ data }) => {
        if (data) {
          setBranches(data);
          setDashboardStats(prev => ({ ...prev, totalBranches: data.length }));
        }
      });
      if (userRole === 'Admin') fetchUsers();
    }
  }, [session, userRole]);

  useEffect(() => {
    if (activeTab === 'dashboard') fetchDashboardData();
    if (activeTab === 'history') fetchHistory();
    if (activeTab === 'consolidated') fetchConsolidated();
    if (activeTab === 'admin' && userRole === 'Admin') fetchUsers();
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

  const exportToCSV = (data, filename) => {
    if (!data || data.length === 0) return alert('No data available to export.');
    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
  };

  // --- CALCULATIONS ---
  const totalStaffActual = staff.reduce((sum, s) => sum + num(s.actual), 0);
  const totalStaffSystem = staff.reduce((sum, s) => sum + num(s.system), 0);
  const totalStaffCredit = staff.reduce((sum, s) => sum + num(s.credit), 0);

  const finalBranchActual = branchActual !== '' ? num(branchActual) : totalStaffActual;
  const finalBranchSystem = branchSystem !== '' ? num(branchSystem) : totalStaffSystem;
  const finalBranchCredit = branchCredit !== '' ? num(branchCredit) : totalStaffCredit;

  const adjustedSystemSales = deductCredit ? (finalBranchSystem - finalBranchCredit) : finalBranchSystem;
  const stockAndSalesResults = calculateStockAndSales(num(openingStock), num(physicalStock), finalBranchActual, adjustedSystemSales);
  const debtLossToAdd = addLossToDebt ? stockAndSalesResults.residualStockLoss : 0;
  const debtResults = calculateDebt(num(openingDebt), num(originalClosingDebt), debtLossToAdd);
  
  const branchName = branches.find(b => b.id === selectedBranch)?.name || '';

  // --- SAVE / UPDATE / DELETE DATABASE ---
  const handleSave = async () => {
    if (!selectedBranch) return alert('Please select a branch first.');
    setIsSaving(true);
    try {
      let reportId = editingReportId;
      const reportPayload = { 
        branch_id: selectedBranch, period_start: periodStart, period_end: periodEnd,
        branch_actual_sales: finalBranchActual, branch_system_sales: finalBranchSystem, branch_credit_sales: finalBranchCredit,
        prev_closing_stock: num(prevClosingStock)
      };

      if (editingReportId) {
        await supabase.from('reports').update(reportPayload).eq('id', editingReportId);
        await supabase.from('stock_takes').delete().eq('report_id', editingReportId);
        await supabase.from('debt_records').delete().eq('report_id', editingReportId);
        await supabase.from('sales_records').delete().eq('report_id', editingReportId);
        await supabase.from('corrective_actions').delete().eq('report_id', editingReportId);
      } else {
        const { data: reportData, error: reportError } = await supabase.from('reports').insert({ ...reportPayload, status: 'Draft' }).select().single();
        if (reportError) throw reportError;
        reportId = reportData.id;
      }
      
      await supabase.from('stock_takes').insert({ report_id: reportId, opening_stock: num(openingStock), physical_stock: num(physicalStock), stock_date: today, valuation_date: periodStart, physical_count_date: periodEnd });
      await supabase.from('debt_records').insert({ report_id: reportId, opening_debt: num(openingDebt), original_closing_debt: num(originalClosingDebt), residual_stock_loss_added: debtLossToAdd, opening_debt_date: openingDebtDate, closing_debt_date: closingDebtDate });

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

      for (const act of actions) {
        if (!act.finding) continue;
        await supabase.from('corrective_actions').insert({
          report_id: reportId, finding: act.finding, amount: num(act.amount), action_required: act.actionRequired,
          responsible_person: act.responsible, deadline: act.deadline || null, status: act.status
        });
      }
      
      alert(editingReportId ? 'Report updated successfully!' : 'Report saved successfully!');
      resetForm(); setActiveTab('history');
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

  const handleApprove = async (reportId) => {
    if(!confirm("Are you sure you want to approve this report? Once approved, it is locked.")) return;
    const { error } = await supabase.from('reports').update({ status: 'Approved' }).eq('id', reportId);
    if (error) alert("Error approving: " + error.message);
    else { alert("Report Approved."); fetchHistory(); }
  };

  const handleAddBranch = async () => {
    if(!newBranchName) return alert("Enter a branch name.");
    const { error } = await supabase.from('branches').insert({ name: newBranchName });
    if(error) alert("Error: " + error.message);
    else {
      alert("Branch added successfully.");
      setNewBranchName('');
      supabase.from('branches').select('*').order('name').then(({ data }) => setBranches(data));
    }
  };

  const toggleBranchStatus = async (id, currentStatus) => {
    const { error } = await supabase.from('branches').update({ is_active: !currentStatus }).eq('id', id);
    if(error) alert("Error: " + error.message);
    else supabase.from('branches').select('*').order('name').then(({ data }) => setBranches(data));
  };

  const handleUpdateSettings = async (key, value) => {
    const { error } = await supabase.from('app_settings').update({ [key]: value }).eq('id', 1);
    if(error) alert("Error updating settings: " + error.message);
    else {
      if(key === 'deduct_credit_sales') setDeductCredit(value);
      if(key === 'add_residual_loss_to_debt') setAddLossToDebt(value);
      alert("Policy updated successfully!");
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', userId);
    if (error) alert("Error updating role: " + error.message);
    else { alert("User role updated!"); fetchUsers(); }
  };

  const resetForm = () => {
    setEditingReportId(null); setSelectedBranch(''); setOpeningStock(''); setPhysicalStock('');
    setOpeningDebt(''); setOriginalClosingDebt(''); setStaff([{ name: '', actual: '', system: '', credit: '' }]);
    setPeriodStart(today); setPeriodEnd(today); setBranchActual(''); setBranchSystem(''); setBranchCredit(''); setPrevClosingStock('');
    setActions([{ finding: '', amount: '', actionRequired: '', responsible: '', deadline: '', status: 'Pending' }]);
  };

  const handleEditReport = (report) => {
    if (report.status === 'Approved') return alert('Cannot edit an approved report.');
    setEditingReportId(report.id); setSelectedBranch(report.branch_id); setPeriodStart(report.period_start); setPeriodEnd(report.period_end);
    setOpeningStock(report.stock_takes?.[0]?.opening_stock || ''); setPhysicalStock(report.stock_takes?.[0]?.physical_stock || '');
    setOpeningDebt(report.debt_records?.[0]?.opening_debt || ''); setOriginalClosingDebt(report.debt_records?.[0]?.original_closing_debt || '');
    setOpeningDebtDate(report.debt_records?.[0]?.opening_debt_date || today); setClosingDebtDate(report.debt_records?.[0]?.closing_debt_date || today);
    setBranchActual(report.branch_actual_sales || ''); setBranchSystem(report.branch_system_sales || ''); setBranchCredit(report.branch_credit_sales || '');
    setPrevClosingStock(report.prev_closing_stock || '');

    if (report.sales_records && report.sales_records.length > 0) {
      setStaff(report.sales_records.map(sr => ({ name: sr.salespeople?.name || '', actual: sr.actual_sales || '', system: sr.system_sales || '', credit: sr.credit_sales || '' })));
    } else { setStaff([{ name: '', actual: '', system: '', credit: '' }]); }
    
    if (report.corrective_actions && report.corrective_actions.length > 0) {
      setActions(report.corrective_actions.map(a => ({ finding: a.finding, amount: a.amount, actionRequired: a.action_required, responsible: a.responsible_person, deadline: a.deadline, status: a.status })));
    } else {
      setActions([{ finding: '', amount: '', actionRequired: '', responsible: '', deadline: '', status: 'Pending' }]);
    }

    setActiveTab('create');
  };

  // --- FETCH DATA ---
  const fetchDashboardData = async () => {
    setIsLoadingData(true);
    const { data } = await supabase.from('reports').select(`
      id, status, branch_id, branches(name), branch_actual_sales, branch_system_sales, branch_credit_sales, 
      stock_takes(opening_stock, physical_stock), debt_records(opening_debt, original_closing_debt)
    `);
    
    if (data) {
      let pending = 0, tStockLoss = 0, tAdjDebt = 0;
      const branchStats = {};

      data.forEach(r => {
        if (r.status !== 'Approved') pending++;
        
        const adjSys = deductCredit ? (r.branch_system_sales || 0) - (r.branch_credit_sales || 0) : (r.branch_system_sales || 0);
        const res = calculateStockAndSales(r.stock_takes?.[0]?.opening_stock || 0, r.stock_takes?.[0]?.physical_stock || 0, r.branch_actual_sales || 0, adjSys);
        const db = calculateDebt(r.debt_records?.[0]?.opening_debt || 0, r.debt_records?.[0]?.original_closing_debt || 0, addLossToDebt ? res.residualStockLoss : 0);
        
        tStockLoss += res.residualStockLoss; 
        tAdjDebt += db.adjustedClosingDebt;

        // Aggregate for charts
        if (!branchStats[r.branch_id]) {
          branchStats[r.branch_id] = { name: r.branches?.name || 'Unknown', loss: 0, reduction: 0 };
        }
        branchStats[r.branch_id].loss += res.residualStockLoss;
        branchStats[r.branch_id].reduction += db.netDebtReduction;
      });

      // Prepare chart data (Top 5 worst stock losses, Top 5 best debt reductions)
      const sortedLosses = Object.values(branchStats).sort((a, b) => b.loss - a.loss).slice(0, 5);
      const sortedReductions = Object.values(branchStats).sort((a, b) => b.reduction - a.reduction).slice(0, 5);

      setChartData({ debtReductions: sortedReductions, stockLosses: sortedLosses });
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
      const { data: ca } = await supabase.from('corrective_actions').select('*').eq('report_id', r.id);
      fullReports.push({ ...r, stock_takes: st || [], debt_records: dr || [], sales_records: sr || [], corrective_actions: ca || [] });
    }
    setHistoricalReports(fullReports);
    setIsLoadingData(false);
  };

  const fetchConsolidated = async () => {
    setIsLoadingData(true);
    const { data } = await supabase.from('reports').select(`id, period_start, period_end, branch_id, status, branch_actual_sales, branch_system_sales, branch_credit_sales, branches(name), stock_takes(opening_stock, physical_stock), debt_records(opening_debt, original_closing_debt)`).order('created_at', { ascending: false });
    if (data) {
      const grouped = {};
      data.forEach(r => {
        if (!grouped[r.branch_id] || r.status === 'Approved') {
          const adjSys = deductCredit ? (r.branch_system_sales || 0) - (r.branch_credit_sales || 0) : (r.branch_system_sales || 0);
          const results = calculateStockAndSales(r.stock_takes?.[0]?.opening_stock || 0, r.stock_takes?.[0]?.physical_stock || 0, r.branch_actual_sales || 0, adjSys);
          const debt = calculateDebt(r.debt_records?.[0]?.opening_debt || 0, r.debt_records?.[0]?.original_closing_debt || 0, addLossToDebt ? results.residualStockLoss : 0);
          grouped[r.branch_id] = {
            name: r.branches?.name || 'Unknown', period: `${r.period_start} to ${r.period_end}`, status: r.status,
            openingDebt: r.debt_records?.[0]?.opening_debt || 0, adjClosingDebt: debt.adjustedClosingDebt, netReduction: debt.netDebtReduction, stockLoss: results.grossStockVariance, salesVariance: results.salesVariance
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
      const adjSys = deductCredit ? (report.branch_system_sales || 0) - (report.branch_credit_sales || 0) : (report.branch_system_sales || 0);
      const results = calculateStockAndSales(report.stock_takes?.[0]?.opening_stock || 0, report.stock_takes?.[0]?.physical_stock || 0, report.branch_actual_sales || 0, adjSys);
      const debtResults = calculateDebt(report.debt_records?.[0]?.opening_debt || 0, report.debt_records?.[0]?.original_closing_debt || 0, addLossToDebt ? results.residualStockLoss : 0);
      return {
        branchName: report.branches?.name || 'Unknown', periodStart: report.period_start, periodEnd: report.period_end,
        openingStock: report.stock_takes?.[0]?.opening_stock || 0, physicalStock: report.stock_takes?.[0]?.physical_stock || 0, openingDebt: report.debt_records?.[0]?.opening_debt || 0, originalClosingDebt: report.debt_records?.[0]?.original_closing_debt || 0,
        openingDebtDate: report.debt_records?.[0]?.opening_debt_date || 'N/A', closingDebtDate: report.debt_records?.[0]?.closing_debt_date || 'N/A',
        results, debtResults, 
        staff: (report.sales_records || []).map(sr => ({ name: sr.salespeople?.name || '', actual: sr.actual_sales || 0, system: sr.system_sales || 0, credit: sr.credit_sales || 0 })),
        actions: (report.corrective_actions || []).map(a => ({ finding: a.finding, amount: a.amount, actionRequired: a.action_required, responsible: a.responsible_person, deadline: a.deadline, status: a.status })),
        branchActual: report.branch_actual_sales || 0, branchSystem: report.branch_system_sales || 0, branchCredit: report.branch_credit_sales || 0,
        previousStock: report.prev_closing_stock > 0 ? { amount: report.prev_closing_stock, date: 'Manual Entry' } : null
      };
    } else {
      return {
        branchName, periodStart, periodEnd, openingStock: num(openingStock), physicalStock: num(physicalStock), openingDebt: num(openingDebt), originalClosingDebt: num(originalClosingDebt),
        openingDebtDate, closingDebtDate, results: stockAndSalesResults, debtResults,
        staff: staff.map(s => ({ name: s.name || 'Unnamed', actual: num(s.actual), system: num(s.system), credit: num(s.credit) })),
        actions: actions.map(a => ({ finding: a.finding, amount: num(a.amount), actionRequired: a.actionRequired, responsible: a.responsible, deadline: a.deadline, status: a.status })),
        branchActual: finalBranchActual, branchSystem: finalBranchSystem, branchCredit: finalBranchCredit,
        previousStock: num(prevClosingStock) > 0 ? { amount: num(prevClosingStock), date: 'Manual Entry' } : null
      };
    }
  };

  // --- SMART NOTES & PROGRESS ALGORITHM ---
  const generateNotes = (data) => {
    let notes = [];
    if (data.results.salesVariance > 0 && data.results.grossStockShortage > 0) {
      if (data.results.remainingSalesSurplus > 0) notes.push(`The branch recorded a positive sales variance (surplus) of Ksh ${formatKsh(data.results.salesVariance)}. This surplus was applied to fully offset the stock shortage of Ksh ${formatKsh(data.results.grossStockShortage)}, leaving an unreconciled sales surplus of Ksh ${formatKsh(data.results.remainingSalesSurplus)}.`);
      else notes.push(`The branch recorded a positive sales variance of Ksh ${formatKsh(data.results.salesVariance)}. This was applied against the stock shortage of Ksh ${formatKsh(data.results.grossStockShortage)}, reducing the unreconciled residual stock loss to Ksh ${formatKsh(data.results.residualStockLoss)}.`);
    } else if (data.results.salesVariance > 0 && data.results.grossStockShortage === 0) notes.push(`The branch recorded a positive sales variance of Ksh ${formatKsh(data.results.salesVariance)} with no stock shortage. This represents unrecorded cash or timing differences.`);
    else if (data.results.salesVariance <= 0 && data.results.grossStockShortage > 0) notes.push(`No positive sales variance is available to offset the stock shortage. The branch recorded a negative sales variance (cash shortage) of Ksh ${formatKsh(Math.abs(data.results.salesVariance))}, resulting in a full residual stock loss of Ksh ${formatKsh(data.results.residualStockLoss)}.`);

    const unallocActual = data.branchActual - data.staff.reduce((sum, s) => sum + s.actual, 0);
    if (Math.abs(unallocActual) > 0) notes.push(`An unallocated sales gap of Ksh ${formatKsh(unallocActual)} exists between the branch aggregate actual sales and the sum of individual salesperson actual sales. This requires further investigation.`);

    if (data.results.residualStockLoss > 0) {
      if (addLossToDebt) notes.push(`The residual stock loss of Ksh ${formatKsh(data.results.residualStockLoss)} was added to the closing debt, increasing the original closing debt of Ksh ${formatKsh(data.originalClosingDebt)} to an adjusted closing debt of Ksh ${formatKsh(data.debtResults.adjustedClosingDebt)}.`);
      else notes.push(`The residual stock loss of Ksh ${formatKsh(data.results.residualStockLoss)} was NOT added to the debt (per current accounting policy). The adjusted closing debt remains at Ksh ${formatKsh(data.debtResults.adjustedClosingDebt)}.`);
    } else {
      notes.push(`No residual stock loss was added to the debt. The adjusted closing debt remains at Ksh ${formatKsh(data.debtResults.adjustedClosingDebt)}.`);
    }

    if (data.previousStock && data.previousStock.amount !== null) {
      const prevStockVal = data.previousStock.amount;
      const stockChange = data.physicalStock - prevStockVal;
      const debtChange = data.debtResults.adjustedClosingDebt - data.openingDebt;
      let stockTrend = stockChange > 0 ? `increased by Ksh ${formatKsh(stockChange)}` : stockChange < 0 ? `reduced by Ksh ${formatKsh(Math.abs(stockChange))}` : 'remained stagnant';
      let debtTrend = debtChange > 0 ? `increased by Ksh ${formatKsh(Math.abs(debtChange))}` : debtChange < 0 ? `reduced by Ksh ${formatKsh(Math.abs(debtChange))}` : 'remained stagnant';
      
      notes.push(`-- BRANCH PROGRESS ANALYSIS --`);
      notes.push(`Compared to the previous closing stock of Ksh ${formatKsh(prevStockVal)}, the current closing stock has ${stockTrend}. Over the same period, the adjusted branch debt has ${debtTrend}.`);

      if (stockChange >= 0 && debtChange < 0) notes.push(`DIAGNOSIS: EXCELLENT PROGRESS. The branch successfully increased its physical stock holding while simultaneously reducing its debt.`);
      else if (stockChange <= 0 && debtChange < 0) notes.push(`DIAGNOSIS: HEALTHY PROGRESS. The branch liquidated existing stock and used the proceeds to reduce its debt.`);
      else if (stockChange >= 0 && debtChange >= 0) notes.push(`DIAGNOSIS: CONCERNING. Both stock and debt have increased. Investigate credit sales and collection rates.`);
      else if (stockChange < 0 && debtChange >= 0) notes.push(`DIAGNOSIS: CRITICAL RISK. The branch's stock has depleted, yet its debt has increased. Major red flag for unrecorded sales or pilferage.`);
    }
    return notes;
  };

  // --- ADVANCED PDF CHART ENGINE ---
  const drawBarChart = (doc, startX, startY, width, height, data, title) => {
    let maxVal = 0, minVal = 0;
    data.forEach(d => { 
      if (d.val1 > maxVal) maxVal = d.val1; if (d.val1 < minVal) minVal = d.val1;
      if (d.val2 && d.val2 > maxVal) maxVal = d.val2; if (d.val2 && d.val2 < minVal) minVal = d.val2;
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

    const barGroupWidth = width / data.length;
    const barWidth = (barGroupWidth * 0.6) / (data[0].val2 !== undefined ? 2 : 1);

    data.forEach((d, i) => {
      const groupX = startX + (i * barGroupWidth) + (barGroupWidth * 0.2);
      
      const h1 = ((d.val1 - 0) / (maxVal - minVal)) * height;
      doc.setFillColor(d.val1 < 0 ? 192 : 41, d.val1 < 0 ? 57 : 128, d.val1 < 0 ? 43 : 185);
      doc.rect(groupX, h1 > 0 ? zeroLineY - h1 : zeroLineY, barWidth, Math.abs(h1), 'F');
      
      if (d.val2 !== undefined) {
        const h2 = ((d.val2 - 0) / (maxVal - minVal)) * height;
        doc.setFillColor(211, 84, 0);
        doc.rect(groupX + barWidth + 1, h2 > 0 ? zeroLineY - h2 : zeroLineY, barWidth, Math.abs(h2), 'F');
      }

      doc.setFontSize(6); doc.setTextColor(0);
      if (d.val1 !== 0) doc.text(formatNum(d.val1), groupX + barWidth/2, h1 > 0 ? zeroLineY - h1 - 2 : zeroLineY + Math.abs(h1) + 4, { align: 'center' });
      if (d.val2 !== undefined && d.val2 !== 0) doc.text(formatNum(d.val2), groupX + barWidth + 1 + barWidth/2, h2 > 0 ? zeroLineY - h2 - 2 : zeroLineY + Math.abs(h2) + 4, { align: 'center' });

      doc.setFontSize(7); doc.text(d.label.substring(0, 8), groupX + barWidth, startY + height + 4, { align: 'center' });
    });
  };

  const generatePDF = (data, action = 'save') => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(0);
    doc.text('MEDIOCARE PHARMACEUTICALS LTD', pageWidth / 2, 20, { align: 'center' });
    doc.setFontSize(12);
    doc.text(`${data.branchName.toUpperCase()} — STOCK CONTROL & FINANCIAL REPORT`, pageWidth / 2, 28, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(`Period: ${data.periodStart} to ${data.periodEnd}`, pageWidth / 2, 34, { align: 'center' });

    const notes = generateNotes(data);
    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('1. Executive Summary & Diagnostic Notes', 14, 45);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    let summaryY = 52;
    notes.forEach(text => {
      if (text.startsWith('--')) {
        doc.setFont('helvetica', 'bold'); doc.text(text, 14, summaryY); summaryY += 5; doc.setFont('helvetica', 'normal');
      } else {
        const splitText = doc.splitTextToSize(`• ${text}`, pageWidth - 28);
        doc.text(splitText, 14, summaryY); summaryY += (splitText.length * 5) + 2;
      }
    });

    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('2. Stock Position and Offset', 14, summaryY + 5);
    const stockTableBody = [];
    if (data.previousStock && data.previousStock.amount !== null) stockTableBody.push(['Previous Closing Stock', formatKsh(data.previousStock.amount), 'Manual Baseline']);
    stockTableBody.push(
      ['Stock before stock take', formatKsh(data.openingStock), 'Opening (Book)'],
      ['Stock after stock take', formatKsh(data.physicalStock), 'Physical (Closing)'],
      ['Gross Stock Variance', formatKsh(data.results.grossStockVariance), `${(data.results.stockVariancePercentage || 0).toFixed(2)}% of opening`],
      ['Positive Sales Variance', formatKsh(data.results.salesVariance), 'Credit-adjusted'],
      ['Less: Applied to offset', `(${formatKsh(data.results.salesOffset)})`, 'Transferred'],
      ['Residual Stock Loss', formatKsh(data.results.residualStockLoss), 'Added to debt']
    );
    autoTable(doc, { startY: summaryY + 10, head: [['Item', 'Ksh', 'Remarks']], body: stockTableBody, theme: 'grid', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 } });

    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('3. Sales Reconciliation (Credit-Adjusted)', 14, doc.lastAutoTable.finalY + 10);
    const salesBody = data.staff.map(s => [s.name, formatKsh(s.actual), formatKsh(s.system), formatKsh(s.credit), formatKsh(s.system - s.credit), formatKsh(s.actual - (s.system - s.credit))]);
    const unallocActual = data.branchActual - data.staff.reduce((sum, s) => sum + s.actual, 0);
    if (unallocActual !== 0) salesBody.push(['Unallocated', formatKsh(unallocActual), '-', '-', '-', formatKsh(unallocActual)]);
    salesBody.push(['Branch Total', formatKsh(data.branchActual), formatKsh(data.branchSystem), formatKsh(data.branchCredit), formatKsh(data.branchSystem - data.branchCredit), formatKsh(data.results.salesVariance)]);

    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15, head: [['Staff', 'Actual Cash', 'System Sales', 'Credit Sales', 'Adj. System', 'Variance']], body: salesBody, theme: 'striped', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 },
      didParseCell: function (data) { if (data.section === 'body' && data.column.index === 5 && data.cell.text[0].includes('-')) data.cell.styles.textColor = [192, 57, 43]; }
    });

    doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text('4. Branch Account Debt Movement', 14, doc.lastAutoTable.finalY + 10);
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 15, head: [['Position', 'Date', 'Ksh']], 
      body: [
        ['Opening Debt', data.openingDebtDate, `(${formatKsh(data.openingDebt)})`],
        ['Original Closing Debt', data.closingDebtDate, `(${formatKsh(data.originalClosingDebt)})`],
        ['Gross Debt Reduction', '-', formatKsh(data.debtResults.grossDebtReduction)],
        ['Add: Residual Stock Loss', '-', formatKsh(data.results.residualStockLoss)],
        ['Adjusted Closing Debt', '-', `(${formatKsh(data.debtResults.adjustedClosingDebt)})`],
        ['Net Debt Reduction', '-', formatKsh(data.debtResults.netDebtReduction)],
      ], theme: 'grid', headStyles: { fillColor: [44, 62, 80] }, styles: { fontSize: 8 }
    });

    // 5. RESOLUTIONS & CORRECTIVE ACTIONS
    if (data.actions && data.actions.length > 0 && data.actions[0].finding !== '') {
      doc.setFontSize(11); doc.setFont('helvetica', 'bold');
      doc.text('5. Resolutions & Corrective Actions', 14, doc.lastAutoTable.finalY + 10);
      
      const actBody = data.actions.map(a => [a.finding, formatKsh(a.amount), a.actionRequired, a.responsible, a.deadline, a.status]);
      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 15, head: [['Finding', 'Amount', 'Action Required', 'Responsible', 'Deadline', 'Status']], body: actBody, theme: 'grid', headStyles: { fillColor: [192, 57, 43] }, styles: { fontSize: 8 }
      });
    }

    doc.addPage();
    doc.setFontSize(11); doc.setFont('helvetica', 'bold'); doc.text('6. Graphical Analysis', 14, 20);
    const salesChartData = data.staff.slice(0, 6).map(s => ({ label: s.name, val1: s.actual, val2: s.system - s.credit }));
    if(salesChartData.length > 0) drawBarChart(doc, 20, 40, 170, 60, salesChartData, 'Actual vs Adjusted System Sales per Staff');

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
    
    doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(0);
    doc.text('MEDIOCARE PHARMACEUTICALS LTD', pageWidth / 2, 20, { align: 'center' });
    doc.setFontSize(12); doc.text('COMPANY-WIDE CONSOLIDATED FINANCIAL REPORT', pageWidth / 2, 28, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.text(`Generated on: ${new Date().toLocaleString()} | Base Currency: KES`, pageWidth / 2, 34, { align: 'center' });

    const totals = consolidatedData.reduce((acc, curr) => {
      acc.openingDebt += curr.openingDebt; acc.adjClosingDebt += curr.adjClosingDebt; acc.netReduction += curr.netReduction; acc.stockLoss += curr.stockLoss; acc.salesVariance += curr.salesVariance;
      return acc;
    }, { openingDebt: 0, adjClosingDebt: 0, netReduction: 0, stockLoss: 0, salesVariance: 0 });

    const tableBody = consolidatedData.map(d => [d.name, d.period, d.status, formatKsh(d.openingDebt), formatKsh(d.adjClosingDebt), formatKsh(d.netReduction), formatKsh(d.stockLoss), formatKsh(d.salesVariance)]);

    autoTable(doc, {
      startY: 45, head: [['Branch', 'Period', 'Status', 'Opening Debt', 'Adj. Closing Debt', 'Net Reduction', 'Stock Loss', 'Sales Var.']], body: tableBody,
      foot: [['GRAND TOTALS', '-', '-', formatKsh(totals.openingDebt), formatKsh(totals.adjClosingDebt), formatKsh(totals.netReduction), formatKsh(totals.stockLoss), formatKsh(totals.salesVariance)]],
      theme: 'grid', headStyles: { fillColor: [44, 62, 80] }, footStyles: { fillColor: [0, 0, 0], textColor: [255, 255, 255], fontStyle: 'bold' }, styles: { fontSize: 8 }
    });

    const chartData = consolidatedData.slice(0, 12).map(d => ({ label: d.name, val1: d.netReduction }));
    if(chartData.length > 0) drawBarChart(doc, 14, doc.lastAutoTable.finalY + 25, pageWidth - 28, 50, chartData, 'Net Debt Reduction by Branch (Positive = Good)');

    doc.save(`Company_Consolidated_Report.pdf`);
  };

  // --- WEB PREVIEW CHART RENDERER ---
  const renderPreviewChart = (staffData) => {
    if(staffData.length === 0) return null;
    const maxVal = Math.max(...staffData.map(s => Math.max(s.actual, s.system)), 1);
    
    return (
      <div style={{ marginTop: '20px', padding: '20px', backgroundColor: '#f9f9f9', border: '1px solid #ddd', borderRadius: '8px' }}>
        <h4 style={{ margin: '0 0 20px 0', textAlign: 'center', color: '#333' }}>Actual vs System Sales per Staff</h4>
        <div style={{ display: 'flex', alignItems: 'flex-end', height: '150px', gap: '15px', padding: '0 10px' }}>
          {staffData.map((s, i) => {
            const actualHeight = (s.actual / maxVal) * 100;
            const systemHeight = (s.system / maxVal) * 100;
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, height: '100%', justifyContent: 'flex-end' }}>
                <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', height: '100%' }}>
                  <div style={{ width: '20px', height: `${Math.max(actualHeight, 1)}%`, backgroundColor: '#333', position: 'relative' }} title={`Actual: ${formatKsh(s.actual)}`}>
                    <span style={{ position: 'absolute', top: '-20px', left: '50%', transform: 'translateX(-50%)', fontSize: '10px', fontWeight: 'bold', whiteSpace: 'nowrap' }}>{formatNum(s.actual)}</span>
                  </div>
                  <div style={{ width: '20px', height: `${Math.max(systemHeight, 1)}%`, backgroundColor: '#aaa', position: 'relative' }} title={`System: ${formatKsh(s.system)}`}>
                    <span style={{ position: 'absolute', top: '-20px', left: '50%', transform: 'translateX(-50%)', fontSize: '10px', whiteSpace: 'nowrap' }}>{formatNum(s.system)}</span>
                  </div>
                </div>
                <span style={{ fontSize: '11px', marginTop: '10px', fontWeight: 'bold' }}>{s.name}</span>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginTop: '15px', fontSize: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><div style={{ width: '12px', height: '12px', backgroundColor: '#333' }}></div> Actual</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><div style={{ width: '12px', height: '12px', backgroundColor: '#aaa' }}></div> System</div>
        </div>
      </div>
    );
  };

  // --- DASHBOARD CHART RENDERER ---
  const renderDashboardChart = (data, title, color, isLoss = false) => {
    if (!data || data.length === 0) return <p style={{ color: '#666' }}>No data available.</p>;
    const maxVal = Math.max(...data.map(d => Math.abs(isLoss ? d.loss : d.reduction)), 1);

    return (
      <div style={{ padding: '20px', backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #eee', boxShadow: '0 2px 8px rgba(0,0,0,0.05)' }}>
        <h4 style={{ margin: '0 0 20px 0', textAlign: 'center', color: '#333' }}>{title}</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          {data.map((d, i) => {
            const val = isLoss ? d.loss : d.reduction;
            const pct = (Math.abs(val) / maxVal) * 100;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ width: '80px', fontSize: '13px', fontWeight: 'bold', textAlign: 'right' }}>{d.name}</span>
                <div style={{ flex: 1, backgroundColor: '#f0f0f0', borderRadius: '4px', height: '24px', position: 'relative' }}>
                  <div style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: color, height: '100%', borderRadius: '4px' }}></div>
                </div>
                <span style={{ width: '100px', fontSize: '13px', fontWeight: 'bold', color: val < 0 ? '#dc3545' : '#333' }}>
                  Ksh {formatNum(val)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
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
          {userRole === 'Admin' && (
            <button onClick={() => setActiveTab('admin')} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'admin' ? '#333' : '#eee', color: activeTab === 'admin' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>Admin Settings</button>
          )}
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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            {renderDashboardChart(chartData.stockLosses, 'Top 5 Branches by Stock Loss (Ksh)', '#dc3545', true)}
            {renderDashboardChart(chartData.debtReductions, 'Top 5 Branches by Net Debt Reduction (Ksh)', '#28a745', false)}
          </div>
        </div>
      )}

      {/* ADMIN SETTINGS TAB */}
      {activeTab === 'admin' && userRole === 'Admin' && (
        <div>
          <h2 style={{ marginBottom: '20px' }}>Admin Management</h2>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
            {/* ACCOUNTING POLICIES */}
            <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', border: '1px solid #ddd' }}>
              <h3 style={{ marginTop: 0 }}>Accounting Policies</h3>
              <p style={{ fontSize: '13px', color: '#666' }}>These settings apply globally to all new reports and consolidated calculations.</p>
              
              <div style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px', backgroundColor: '#fff', border: '1px solid #eee' }}>
                <div>
                  <strong>Deduct Credit Sales from System Sales</strong>
                  <div style={{ fontSize: '12px', color: '#666' }}>If enabled, Adjusted System = System - Credit.</div>
                </div>
                <input type="checkbox" checked={deductCredit} onChange={e => handleUpdateSettings('deduct_credit_sales', e.target.checked)} style={{ width: '20px', height: '20px', cursor: 'pointer' }} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px', backgroundColor: '#fff', border: '1px solid #eee' }}>
                <div>
                  <strong>Add Residual Stock Loss to Debt</strong>
                  <div style={{ fontSize: '12px', color: '#666' }}>If enabled, Adjusted Debt includes the residual loss.</div>
                </div>
                <input type="checkbox" checked={addLossToDebt} onChange={e => handleUpdateSettings('add_residual_loss_to_debt', e.target.checked)} style={{ width: '20px', height: '20px', cursor: 'pointer' }} />
              </div>
            </div>

            {/* BRANCH MANAGEMENT */}
            <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', border: '1px solid #ddd' }}>
              <h3 style={{ marginTop: 0 }}>Manage Branches</h3>
              <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <input type="text" value={newBranchName} onChange={e => setNewBranchName(e.target.value)} placeholder="New Branch Name" style={{ flex: 1, padding: '10px', border: '1px solid #ccc', borderRadius: '4px' }} />
                <button onClick={handleAddBranch} style={{ padding: '10px 20px', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Add Branch</button>
              </div>
              
              <div style={{ maxHeight: '250px', overflowY: 'auto', border: '1px solid #eee' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f0f0f0', borderBottom: '1px solid #ddd' }}>
                      <th style={{ padding: '8px', textAlign: 'left' }}>Branch Name</th>
                      <th style={{ padding: '8px', textAlign: 'center' }}>Status</th>
                      <th style={{ padding: '8px', textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {branches.map(b => (
                      <tr key={b.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '8px' }}>{b.name}</td>
                        <td style={{ padding: '8px', textAlign: 'center' }}>
                          <span style={{ color: b.is_active ? 'green' : 'red', fontWeight: 'bold' }}>{b.is_active ? 'Active' : 'Inactive'}</span>
                        </td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>
                          <button onClick={() => toggleBranchStatus(b.id, b.is_active)} style={{ padding: '4px 8px', backgroundColor: b.is_active ? '#dc3545' : '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}>
                            {b.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* USER MANAGEMENT */}
          <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', border: '1px solid #ddd' }}>
            <h3 style={{ marginTop: 0 }}>User Management</h3>
            <p style={{ fontSize: '13px', color: '#666' }}>Manage system access levels for registered users.</p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ backgroundColor: '#f0f0f0', borderBottom: '1px solid #ddd' }}>
                  <th style={{ padding: '10px', textAlign: 'left' }}>Email</th>
                  <th style={{ padding: '10px', textAlign: 'left' }}>Role</th>
                  <th style={{ padding: '10px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {usersList.map(u => (
                  <tr key={u.id} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '10px' }}>{u.email}</td>
                    <td style={{ padding: '10px' }}>
                      <select 
                        value={u.role || 'Stock Controller'} 
                        onChange={(e) => handleRoleChange(u.id, e.target.value)}
                        disabled={u.email === session.user.email}
                        style={{ padding: '6px', borderRadius: '4px', border: '1px solid #ccc', backgroundColor: u.email === session.user.email ? '#eee' : '#fff' }}
                      >
                        <option value="Admin">Admin</option>
                        <option value="Stock Controller">Stock Controller</option>
                        <option value="Branch Manager">Branch Manager</option>
                        <option value="Finance">Finance</option>
                      </select>
                    </td>
                    <td style={{ padding: '10px', textAlign: 'right' }}>
                      {u.email === session.user.email ? <span style={{ fontSize: '11px', color: '#666' }}>Current User</span> : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                {branches.filter(b => b.is_active).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
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
                <h3 style={{ marginTop: 0 }}>1. Stock & Debt Core</h3>
                <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ display: 'block', fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' }}>Previous Closing Stock (Manual)</label>
                    <input type="number" value={prevClosingStock} onChange={e => setPrevClosingStock(e.target.value)} placeholder="Baseline for progress" style={{ width: '100%', padding: '10px', border: '1px solid #ccc', borderRadius: '4px', backgroundColor: '#fff9e6' }} />
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

              {/* CORRECTIVE ACTIONS */}
              <div style={{ padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', marginBottom: '20px', border: '1px solid #ddd' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                  <h3 style={{ margin: 0 }}>4. Resolutions & Actions</h3>
                  <button onClick={() => setActions([...actions, { finding: '', amount: '', actionRequired: '', responsible: '', deadline: '', status: 'Pending' }])} style={{ padding: '8px 12px', cursor: 'pointer', backgroundColor: '#0070f3', color: '#fff', border: 'none', borderRadius: '4px' }}>+ Add Action</button>
                </div>
                {actions.map((a, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '10px', padding: '10px', border: '1px solid #ddd', borderRadius: '4px' }}>
                    <div style={{ gridColumn: 'span 2' }}>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold' }}>Finding</label>
                      <input type="text" value={a.finding} onChange={e => { const n = [...actions]; n[i].finding = e.target.value; setActions(n); }} style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold' }}>Amount (Ksh)</label>
                      <input type="number" value={a.amount} onChange={e => { const n = [...actions]; n[i].amount = e.target.value; setActions(n); }} style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold' }}>Action Required</label>
                      <input type="text" value={a.actionRequired} onChange={e => { const n = [...actions]; n[i].actionRequired = e.target.value; setActions(n); }} style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold' }}>Responsible</label>
                      <input type="text" value={a.responsible} onChange={e => { const n = [...actions]; n[i].responsible = e.target.value; setActions(n); }} style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
                    </div>
                    <div style={{ display: 'flex', gap: '5px' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold' }}>Deadline</label>
                        <input type="date" value={a.deadline} onChange={e => { const n = [...actions]; n[i].deadline = e.target.value; setActions(n); }} style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: '11px', fontWeight: 'bold' }}>Status</label>
                        <select value={a.status} onChange={e => { const n = [...actions]; n[i].status = e.target.value; setActions(n); }} style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}>
                          <option>Pending</option>
                          <option>In Progress</option>
                          <option>Resolved</option>
                        </select>
                      </div>
                    </div>
                    <button onClick={() => setActions(actions.filter((_, idx) => idx !== i))} style={{ gridColumn: 'span 2', marginTop: '5px', padding: '6px', backgroundColor: '#ff4d4f', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Remove Action</button>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h2 style={{ margin: 0 }}>Saved Reports</h2>
            <button onClick={() => exportToCSV(historicalReports.map(r => ({ Branch: r.branches?.name, Period: `${r.period_start} to ${r.period_end}`, Status: r.status, Date: r.created_at })), 'History_Export.csv')} style={{ padding: '10px 20px', backgroundColor: '#4caf50', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Export History CSV</button>
          </div>
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
                        <span style={{ padding: '4px 8px', backgroundColor: r.status === 'Approved' ? '#28a745' : '#ff9800', color: '#fff', borderRadius: '12px', fontSize: '12px', fontWeight: 'bold' }}>{r.status}</span>
                      </td>
                      <td style={{ padding: '10px', display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                        <button onClick={() => setViewingReport(buildReportData(true, r))} style={{ padding: '6px 12px', backgroundColor: '#0070f3', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>View Report</button>
                        {r.status !== 'Approved' && (
                          <>
                            <button onClick={() => handleEditReport(r)} style={{ padding: '6px 12px', backgroundColor: '#ff9800', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Edit</button>
                            {userRole === 'Admin' && <button onClick={() => handleApprove(r.id)} style={{ padding: '6px 12px', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Approve</button>}
                            {userRole === 'Admin' && <button onClick={() => handleDelete(r.id)} style={{ padding: '6px 12px', backgroundColor: '#dc3545', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Delete</button>}
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
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => exportToCSV(consolidatedData, 'Consolidated_Export.csv')} style={{ padding: '10px 20px', backgroundColor: '#4caf50', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Export CSV</button>
              <button onClick={generateConsolidatedPDF} style={{ padding: '10px 20px', backgroundColor: '#000', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Download Master PDF</button>
            </div>
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

      {/* FULL SCREEN DOCUMENT VIEWER MODAL */}
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

              {/* SECTION 5: CORRECTIVE ACTIONS */}
              {viewingReport.actions && viewingReport.actions.length > 0 && viewingReport.actions[0].finding !== '' && (
                <>
                  <h3 style={{ fontSize: '16px', borderBottom: '2px solid #000', paddingBottom: '5px', marginTop: '30px' }}>5. Resolutions & Corrective Actions</h3>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginTop: '10px' }}>
                    <thead><tr style={{ backgroundColor: '#c0392b', color: '#fff' }}>
                      <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #000' }}>Finding</th>
                      <th style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>Amount</th>
                      <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #000' }}>Action Required</th>
                      <th style={{ padding: '8px', textAlign: 'left', border: '1px solid #000' }}>Responsible</th>
                      <th style={{ padding: '8px', textAlign: 'center', border: '1px solid #000' }}>Deadline</th>
                      <th style={{ padding: '8px', textAlign: 'center', border: '1px solid #000' }}>Status</th>
                    </tr></thead>
                    <tbody>
                      {viewingReport.actions.map((a, i) => (
                        <tr key={i}>
                          <td style={{ padding: '8px', border: '1px solid #000' }}>{a.finding}</td>
                          <td style={{ padding: '8px', textAlign: 'right', border: '1px solid #000' }}>{formatKsh(a.amount)}</td>
                          <td style={{ padding: '8px', border: '1px solid #000' }}>{a.actionRequired}</td>
                          <td style={{ padding: '8px', border: '1px solid #000' }}>{a.responsible}</td>
                          <td style={{ padding: '8px', textAlign: 'center', border: '1px solid #000' }}>{a.deadline}</td>
                          <td style={{ padding: '8px', textAlign: 'center', border: '1px solid #000' }}>{a.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {renderPreviewChart(viewingReport.staff)}

            </div>
          </div>
        </div>
      )}
    </main>
  );
}
