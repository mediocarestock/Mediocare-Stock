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
  
  // Modals
  const [viewingReport, setViewingReport] = useState(null);

  // --- DASHBOARD STATE ---
  const [dashboardStats, setDashboardStats] = useState({
    totalBranches: 17, pendingReports: 0, totalStockLoss: 0, totalAdjustedDebt: 0
  });

  // --- CREATE / EDIT REPORT STATE ---
  const [editingReportId, setEditingReportId] = useState(null); // Tracks if we are editing
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

  // --- CSV UPLOAD ---
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
        // UPDATE EXISTING
        const { error: updateErr } = await supabase.from('reports').update({
          branch_id: selectedBranch, period_start: periodStart, period_end: periodEnd
        }).eq('id', editingReportId);
        if (updateErr) throw updateErr;

        // Delete old child records to replace them
        await supabase.from('stock_takes').delete().eq('report_id', editingReportId);
        await supabase.from('debt_records').delete().eq('report_id', editingReportId);
        await supabase.from('sales_records').delete().eq('report_id', editingReportId);

      } else {
        // INSERT NEW
        const { data: reportData, error: reportError } = await supabase.from('reports').insert({ 
          branch_id: selectedBranch, period_start: periodStart, period_end: periodEnd, status: 'Draft' 
        }).select().single();
        if (reportError) throw reportError;
        reportId = reportData.id;
      }
      
      // Insert fresh child records
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

  // --- EDIT REPORT ---
  const handleEditReport = (report) => {
    if (report.status === 'Approved') return alert('Cannot edit an approved report.');
    
    setEditingReportId(report.id);
    setSelectedBranch(report.branch_id);
    setPeriodStart(report.period_start);
    setPeriodEnd(report.period_end);
    
    // Stock
    setOpeningStock(report.stock_takes?.[0]?.opening_stock || '');
    setPhysicalStock(report.stock_takes?.[0]?.physical_stock || '');
    
    // Debt
    setOpeningDebt(report.debt_records?.[0]?.opening_debt || '');
    setOriginalClosingDebt(report.debt_records?.[0]?.original_closing_debt || '');
    setOpeningDebtDate(report.debt_records?.[0]?.opening_debt_date || today);
    setClosingDebtDate(report.debt_records?.[0]?.closing_debt_date || today);

    // Salespeople
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

  // --- APPROVE REPORT ---
  const handleApprove = async (reportId) => {
    if(!confirm("Are you sure you want to approve this report? Once approved, it is locked for audit purposes.")) return;
    const { error } = await supabase.from('reports').update({ status: 'Approved' }).eq('id', reportId);
    if (error) alert("Error approving: " + error.message);
    else { alert("Report Approved successfully."); fetchHistory(); }
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
    // We fetch ALL related data now so we can display it in the View modal and Edit form
    const { data } = await supabase.from('reports').select(`
      id, branch_id, period_start, period_end, status, created_at, branches (name),
      stock_takes(opening_stock, physical_stock, opening_debt_date, closing_debt_date),
      debt_records(opening_debt, original_closing_debt, opening_debt_date, closing_debt_date),
      sales_records(actual_sales, system_sales, credit_sales, salespeople(name))
    `).order('created_at', { ascending: false });
    setHistoricalReports(data || []);
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

  // --- PDF GENERATION ---
  const generateBranchPDF = (data, action = 'save') => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text('MEDIOCARE PHARMACEUTICALS LTD', pageWidth / 2, 20, { align: 'center' });
    doc.setFontSize(12);
    doc.text(`${data.branchName.toUpperCase()} — FINANCIAL REPORT`, pageWidth / 2, 28, { align: 'center' });
    
    autoTable(doc, {
      startY: 40,
      head: [['Metric', 'Amount (Ksh)']],
      body: [
        ['Stock Variance', formatKsh(data.results.grossStockVariance)],
        ['Sales Variance', formatKsh(data.results.salesVariance)],
        ['Residual Stock Loss', formatKsh(data.results.residualStockLoss)],
        ['Adjusted Closing Debt', formatKsh(data.debtResults.adjustedClosingDebt)],
        ['Net Debt Reduction', formatKsh(data.debtResults.netDebtReduction)],
      ],
      theme: 'grid', headStyles: { fillColor: [44, 62, 80] }
    });

    if (action === 'view') {
      window.open(doc.output('bloburl'), '_blank'); // Open in new tab
    } else {
      doc.save(`${data.branchName}_Report.pdf`); // Download
    }
  };

  const handleGenerateLivePDF = (action) => {
    if(!selectedBranch) return alert("Select a branch first");
    generateBranchPDF({ branchName, results: stockAndSalesResults, debtResults }, action);
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

    generateBranchPDF({ branchName: report.branches?.name || 'Unknown', results, debtResults }, action);
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

  // --- MAIN APP UI ---
  return (
    <main style={{ maxWidth: '1200px', margin: '40px auto', fontFamily: 'system-ui', padding: '0 20px' }}>
      
      {/* HEADER */}
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
              <p style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#666', fontWeight: 'bold' }}>Reports Pending Approval</p>
              <h1 style={{ margin: 0, fontSize: '32px', color: '#ff9800' }}>{dashboardStats.pendingReports}</h1>
            </div>
            <div style={{ padding: '20px', backgroundColor: '#f8d7da', borderRadius: '8px', borderLeft: '5px solid #dc3545' }}>
              <p style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#666', fontWeight: 'bold' }}>Total Residual Stock Loss</p>
              <h1 style={{ margin: 0, fontSize: '28px', color: '#dc3545' }}>Ksh {formatKsh(dashboardStats.totalStockLoss)}</h1>
            </div>
            <div style={{ padding: '20px', backgroundColor: '#d4edda', borderRadius: '8px', borderLeft: '5px solid #28a745' }}>
              <p style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#666', fontWeight: 'bold' }}>Total Adjusted Closing Debt</p>
              <h1 style={{ margin: 0, fontSize: '28px', color: '#28a745' }}>Ksh {formatKsh(dashboardStats.totalAdjustedDebt)}</h1>
            </div>
          </div>
        </div>
      )}

      {/* CREATE / EDIT TAB */}
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
                <button onClick={() => handleGenerateLivePDF('view')} style={{ flex: 1, padding: '15px', backgroundColor: '#000', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                  Preview PDF
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
                {historicalReports.map(r => (
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
                      <button onClick={() => setViewingReport(r)} style={{ padding: '6px 12px', backgroundColor: '#0070f3', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>View Data</button>
                      
                      {r.status !== 'Approved' && (
                        <>
                          <button onClick={() => handleEditReport(r)} style={{ padding: '6px 12px', backgroundColor: '#ff9800', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Edit</button>
                          <button onClick={() => handleApprove(r.id)} style={{ padding: '6px 12px', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Approve</button>
                        </>
                      )}
                      
                      <button onClick={() => handleGenerateHistoryPDF(r, 'view')} style={{ padding: '6px 12px', backgroundColor: '#333', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Open PDF</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* VIEW REPORT MODAL */}
      {viewingReport && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ backgroundColor: '#fff', padding: '30px', borderRadius: '8px', width: '90%', maxWidth: '800px', maxHeight: '90%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0 }}>Report Details</h2>
              <button onClick={() => setViewingReport(null)} style={{ padding: '8px 12px', backgroundColor: '#ff4d4f', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Close</button>
            </div>

            <p><strong>Branch:</strong> {viewingReport.branches?.name}</p>
            <p><strong>Period:</strong> {viewingReport.period_start} to {viewingReport.period_end}</p>
            <p><strong>Status:</strong> {viewingReport.status}</p>
            
            <hr style={{ margin: '20px 0' }} />
            
            <h3>Stock Data</h3>
            <p>Opening Stock: Ksh {formatKsh(viewingReport.stock_takes?.[0]?.opening_stock || 0)}</p>
            <p>Physical Stock: Ksh {formatKsh(viewingReport.stock_takes?.[0]?.physical_stock || 0)}</p>
            
            <h3 style={{ marginTop: '20px' }}>Debt Data</h3>
            <p>Opening Debt: Ksh {formatKsh(viewingReport.debt_records?.[0]?.opening_debt || 0)}</p>
            <p>Original Closing Debt: Ksh {formatKsh(viewingReport.debt_records?.[0]?.original_closing_debt || 0)}</p>

            <h3 style={{ marginTop: '20px' }}>Salespeople</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px', marginTop: '10px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #ddd', backgroundColor: '#f5f5f5' }}>
                  <th style={{ padding: '8px' }}>Name</th>
                  <th style={{ padding: '8px' }}>Actual</th>
                  <th style={{ padding: '8px' }}>System</th>
                  <th style={{ padding: '8px' }}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {viewingReport.sales_records?.map((sr, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '8px' }}>{sr.salespeople?.name}</td>
                    <td style={{ padding: '8px' }}>{formatKsh(sr.actual_sales)}</td>
                    <td style={{ padding: '8px' }}>{formatKsh(sr.system_sales)}</td>
                    <td style={{ padding: '8px' }}>{formatKsh(sr.credit_sales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            
            <div style={{ marginTop: '30px', display: 'flex', gap: '10px' }}>
              <button onClick={() => handleGenerateHistoryPDF(viewingReport, 'save')} style={{ padding: '10px 20px', backgroundColor: '#000', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>Download PDF</button>
            </div>
          </div>
        </div>
      )}

    </main>
  );
}
