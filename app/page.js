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
  const [activeTab, setActiveTab] = useState('create'); // 'create', 'history', 'consolidated'
  const [branches, setBranches] = useState([]);
  const [isSaving, setIsSaving] = useState(false);

  // --- CREATE REPORT STATE ---
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
        if (data) setBranches(data);
      });
    }
  }, [session]);

  useEffect(() => {
    if (activeTab === 'history') fetchHistory();
    if (activeTab === 'consolidated') fetchConsolidated();
  }, [activeTab]);

  // --- HELPERS ---
  const num = (val) => parseFloat(val) || 0;
  const formatKsh = (amount) => new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);

  // --- CSV UPLOAD ---
  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
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

  // --- SAVE TO DATABASE ---
  const handleSave = async () => {
    if (!selectedBranch) return alert('Please select a branch first.');
    setIsSaving(true);
    try {
      const { data: reportData, error: reportError } = await supabase.from('reports').insert({ branch_id: selectedBranch, period_start: periodStart, period_end: periodEnd, status: 'Draft' }).select().single();
      if (reportError) throw reportError;
      
      await supabase.from('stock_takes').insert({ 
        report_id: reportData.id, opening_stock: num(openingStock), physical_stock: num(physicalStock), stock_date: today, valuation_date: periodStart, physical_count_date: periodEnd 
      });
      
      await supabase.from('debt_records').insert({ 
        report_id: reportData.id, opening_debt: num(openingDebt), original_closing_debt: num(originalClosingDebt), residual_stock_loss_added: stockAndSalesResults.residualStockLoss, opening_debt_date: openingDebtDate, closing_debt_date: closingDebtDate 
      });

      for (const person of staff) {
        if (!person.name) continue;
        let { data: existingStaff } = await supabase.from('salespeople').select('id').eq('branch_id', selectedBranch).eq('name', person.name).limit(1);
        let spId = existingStaff?.[0]?.id;
        if (!spId) {
          const { data: newSp } = await supabase.from('salespeople').insert({ branch_id: selectedBranch, name: person.name }).select().single();
          spId = newSp.id;
        }
        await supabase.from('sales_records').insert({ report_id: reportData.id, salesperson_id: spId, actual_sales: num(person.actual), system_sales: num(person.system), credit_sales: num(person.credit) });
      }
      alert('Report saved successfully!');
      setActiveTab('history');
    } catch (err) {
      alert('Error saving: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  // --- FETCH DATA ---
  const fetchHistory = async () => {
    setIsLoadingData(true);
    const { data } = await supabase.from('reports').select(`id, period_start, period_end, status, created_at, branches (name)`).order('created_at', { ascending: false });
    setHistoricalReports(data || []);
    setIsLoadingData(false);
  };

  const fetchConsolidated = async () => {
    setIsLoadingData(true);
    const { data } = await supabase.from('reports').select(`
      id, period_start, period_end, branch_id, branches(name),
      stock_takes(opening_stock, physical_stock),
      debt_records(opening_debt, original_closing_debt),
      sales_records(actual_sales, system_sales, credit_sales)
    `).order('created_at', { ascending: false });

    if (data) {
      const grouped = {};
      data.forEach(r => {
        if (!grouped[r.branch_id]) {
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
            name: r.branches?.name || 'Unknown', period: `${r.period_start} to ${r.period_end}`,
            openingDebt: oDebt, adjClosingDebt: debt.adjustedClosingDebt,
            netReduction: debt.netDebtReduction, stockLoss: results.grossStockVariance,
            salesVariance: results.salesVariance
          };
        }
      });
      setConsolidatedData(Object.values(grouped));
    }
    setIsLoadingData(false);
  };

  // --- PDF GENERATORS ---
  const generateBranchPDF = (data) => {
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
    doc.save(`${data.branchName}_Report.pdf`);
  };

  const handleGenerateLivePDF = () => {
    if(!selectedBranch) return alert("Select a branch first");
    generateBranchPDF({ branchName, results: stockAndSalesResults, debtResults });
  };

  const generateConsolidatedPDF = () => {
    const doc = new jsPDF('landscape');
    const pageWidth = doc.internal.pageSize.getWidth();
    
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text('MEDIOCARE PHARMACEUTICALS LTD', pageWidth / 2, 20, { align: 'center' });
    doc.setFontSize(12);
    doc.text('COMPANY-WIDE CONSOLIDATED FINANCIAL REPORT', pageWidth / 2, 28, { align: 'center' });
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(`Generated on: ${new Date().toLocaleString()}`, pageWidth / 2, 34, { align: 'center' });

    const tableBody = consolidatedData.map(d => [
      d.name, d.period, formatKsh(d.openingDebt), formatKsh(d.adjClosingDebt), 
      formatKsh(d.netReduction), formatKsh(d.stockLoss), formatKsh(d.salesVariance)
    ]);

    autoTable(doc, {
      startY: 45,
      head: [['Branch', 'Period', 'Opening Debt', 'Adj. Closing Debt', 'Net Reduction', 'Stock Loss', 'Sales Variance']],
      body: tableBody,
      theme: 'grid', 
      headStyles: { fillColor: [44, 62, 80] },
      styles: { fontSize: 8 }
    });

    doc.save(`Company_Consolidated_Report.pdf`);
  };

  // --- AUTHENTICATION UI ---
  if (authLoading) return <div style={{ padding: '50px', textAlign: 'center' }}>Loading System...</div>;

  if (!session) {
    return (
      <div style={{ maxWidth: '400px', margin: '100px auto', fontFamily: 'system-ui', padding: '30px', border: '1px solid #ddd', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
        <h2 style={{ textAlign: 'center', marginBottom: '20px' }}>Mediocare Login</h2>
        <form onSubmit={async (e) => {
          e.preventDefault();
          setAuthError('');
          const { error } = isSignUp 
            ? await supabase.auth.signUp({ email, password })
            : await supabase.auth.signInWithPassword({ email, password });
          if (error) setAuthError(error.message);
          else if (isSignUp) alert('Check your email for the confirmation link!');
        }}>
          {authError && <p style={{ color: 'red', fontSize: '14px' }}>{authError}</p>}
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '15px', border: '1px solid #ccc', borderRadius: '4px' }} />
          
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required style={{ width: '100%', padding: '10px', marginBottom: '20px', border: '1px solid #ccc', borderRadius: '4px' }} />
          
          <button type="submit" style={{ width: '100%', padding: '12px', backgroundColor: '#000', color: '#fff', border: 'none', borderRadius: '4px', fontWeight: 'bold', cursor: 'pointer' }}>
            {isSignUp ? 'Sign Up' : 'Log In'}
          </button>
        </form>
        <p style={{ textAlign: 'center', marginTop: '20px', cursor: 'pointer', color: '#0070f3', fontSize: '14px' }} onClick={() => setIsSignUp(!isSignUp)}>
          {isSignUp ? 'Already have an account? Log In' : 'Need an account? Sign Up'}
        </p>
      </div>
    );
  }

  // --- MAIN APP UI ---
  return (
    <main style={{ maxWidth: '1200px', margin: '40px auto', fontFamily: 'system-ui', padding: '0 20px' }}>
      
      {/* HEADER & NAVIGATION */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #333', paddingBottom: '10px', marginBottom: '20px' }}>
        <div>
          <h1 style={{ margin: 0 }}>Mediocare System</h1>
          <span style={{ fontSize: '12px', color: '#666' }}>Logged in as: {session.user.email}</span>
        </div>
        <div>
          <button onClick={() => setActiveTab('create')} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'create' ? '#333' : '#eee', color: activeTab === 'create' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>New Report</button>
          <button onClick={() => setActiveTab('history')} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'history' ? '#333' : '#eee', color: activeTab === 'history' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>History</button>
          <button onClick={() => setActiveTab('consolidated')} style={{ padding: '10px 20px', marginRight: '10px', backgroundColor: activeTab === 'consolidated' ? '#333' : '#eee', color: activeTab === 'consolidated' ? '#fff' : '#333', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>Consolidated</button>
          <button onClick={() => supabase.auth.signOut()} style={{ padding: '10px 20px', backgroundColor: '#ff4d4f', color: '#fff', border: 'none', cursor: 'pointer', borderRadius: '4px' }}>Logout</button>
        </div>
      </div>

      {/* CREATE TAB */}
      {activeTab === 'create' && (
        <div>
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
                <button onClick={handleSave} disabled={isSaving} style={{ flex: 1, padding: '15px', backgroundColor: '#0070f3', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                  {isSaving ? 'Saving...' : 'Save to Database'}
                </button>
                <button onClick={handleGenerateLivePDF} style={{ flex: 1, padding: '15px', backgroundColor: '#000', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
                  Download PDF (Preview)
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
                </tr>
              </thead>
              <tbody>
                {historicalReports.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '10px' }}>{new Date(r.created_at).toLocaleDateString()}</td>
                    <td style={{ padding: '10px', fontWeight: 'bold' }}>{r.branches?.name}</td>
                    <td style={{ padding: '10px' }}>{r.period_start} to {r.period_end}</td>
                    <td style={{ padding: '10px' }}><span style={{ padding: '4px 8px', backgroundColor: '#ff9800', color: '#fff', borderRadius: '12px', fontSize: '12px' }}>{r.status}</span></td>
                  </tr>
                ))}
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
