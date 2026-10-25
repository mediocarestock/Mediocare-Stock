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

  // Form State - Financial Figures
  const [openingStock, setOpeningStock] = useState('');
  const [physicalStock, setPhysicalStock] = useState('');
  const [actualSales, setActualSales] = useState('');
  const [systemSales, setSystemSales] = useState('');
  const [creditSales, setCreditSales] = useState('');
  const [openingDebt, setOpeningDebt] = useState('');
  const [originalClosingDebt, setOriginalClosingDebt] = useState('');

  // Form State - Dates
  const today = new Date().toISOString().split('T')[0];
  const [periodStart, setPeriodStart] = useState(today);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [valuationDate, setValuationDate] = useState(today);
  const [physicalCountDate, setPhysicalCountDate] = useState(today);
  const [openingDebtDate, setOpeningDebtDate] = useState(today);
  const [closingDebtDate, setClosingDebtDate] = useState(today);
  
  // Reviewers
  const [preparedBy, setPreparedBy] = useState('');
  const [reviewedBy, setReviewedBy] = useState('');

  useEffect(() => {
    async function getBranches() {
      const { data } = await supabase.from('branches').select('*').order('name');
      if (data) setBranches(data);
    }
    getBranches();
  }, []);

  const num = (val) => parseFloat(val) || 0;
  const adjustedSystemSales = num(systemSales) - num(creditSales);
  
  const stockAndSalesResults = calculateStockAndSales(
    num(openingStock), num(physicalStock), num(actualSales), adjustedSystemSales
  );
  
  const debtResults = calculateDebt(
    num(openingDebt), num(originalClosingDebt), stockAndSalesResults.residualStockLoss
  );

  const formatKsh = (amount) => new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  const formatPct = (pct) => pct === null ? 'N/A' : `${pct.toFixed(2)}%`;
  const branchName = branches.find(b => b.id === selectedBranch)?.name || '';

  const handleSave = async () => {
    // ... (keep the same save logic as before)
    if (!selectedBranch) return alert('Please select a branch first.');
    setIsSaving(true);
    try {
      const { data: reportData, error: reportError } = await supabase.from('reports').insert({ branch_id: selectedBranch, period_start: today, period_end: today, period_start_date: periodStart, period_end_date: periodEnd, status: 'Draft' }).select().single();
      if (reportError) throw reportError;
      const reportId = reportData.id;
      await supabase.from('stock_takes').insert({ report_id: reportId, opening_stock: num(openingStock), physical_stock: num(physicalStock), stock_date: today, valuation_date: valuationDate, physical_count_date: physicalCountDate });
      await supabase.from('debt_records').insert({ report_id: reportId, opening_debt: num(openingDebt), original_closing_debt: num(originalClosingDebt), residual_stock_loss_added: stockAndSalesResults.residualStockLoss, opening_debt_date: openingDebtDate, closing_debt_date: closingDebtDate });
      const { data: spData } = await supabase.from('salespeople').select('id').eq('branch_id', selectedBranch).limit(1);
      let spId = spData?.[0]?.id;
      if (!spId) {
        const { data: newSp } = await supabase.from('salespeople').insert({ branch_id: selectedBranch, name: 'Branch Aggregate' }).select().single();
        spId = newSp.id;
      }
      await supabase.from('sales_records').insert({ report_id: reportId, salesperson_id: spId, actual_sales: num(actualSales), system_sales: num(systemSales), credit_sales: num(creditSales) });
      alert('Report saved successfully!');
    } catch (err) { alert('Error saving: ' + err.message); } finally { setIsSaving(false); }
  };

  const generatePDF = () => {
    if (!selectedBranch) return alert('Please select a branch first.');
    
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    // --- HEADER ---
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('MEDIOCARE PHARMACEUTICALS LTD', pageWidth / 2, 20, { align: 'center' });
    
    doc.setFontSize(14);
    doc.text(`${branchName.toUpperCase()} — STOCK CONTROL & FINANCIAL REPORT`, pageWidth / 2, 30, { align: 'center' });
    
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Reporting Period: ${periodStart} to ${periodEnd} | Currency: Kenya Shillings (KSh)`, pageWidth / 2, 38, { align: 'center' });

    // --- SECTION 1: EXECUTIVE SUMMARY ---
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('1. Executive Summary', 14, 50);
    
    autoTable(doc, {
      startY: 55,
      head: [['Key Metric', 'Amount (KSh)']],
      body: [
        ['Actual Sales', formatKsh(num(actualSales))],
        ['Adjusted System Sales', formatKsh(adjustedSystemSales)],
        ['Sales Variance', formatKsh(stockAndSalesResults.salesVariance)],
        ['Gross Stock Variance', formatKsh(stockAndSalesResults.grossStockVariance)],
        ['Residual Stock Loss', formatKsh(stockAndSalesResults.residualStockLoss)],
        ['Original Closing Debt', formatKsh(num(originalClosingDebt))],
        ['Adjusted Closing Debt', formatKsh(debtResults.adjustedClosingDebt)],
        ['Net Debt Reduction', formatKsh(debtResults.netDebtReduction)],
      ],
      theme: 'grid',
      headStyles: { fillColor: [34, 49, 63] },
      styles: { fontSize: 10 }
    });

    // --- SECTION 2: STOCK VALUATION ANALYSIS ---
    let currentY = doc.lastAutoTable.finalY + 15;
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('2. Stock Valuation Analysis', 14, currentY);
    
    autoTable(doc, {
      startY: currentY + 5,
      head: [['Description', 'Date', 'Amount (KSh)']],
      body: [
        ['Book Stock before Stock Take', valuationDate, formatKsh(num(openingStock))],
        ['Physical Stock after Stock Take', physicalCountDate, formatKsh(num(physicalStock))],
        ['Gross Stock Variance', '-', formatKsh(stockAndSalesResults.grossStockVariance)],
        ['Stock Variance Percentage', '-', formatPct(stockAndSalesResults.stockVariancePercentage)],
      ],
      theme: 'striped',
      headStyles: { fillColor: [41, 128, 185] },
      styles: { fontSize: 10 }
    });

    // --- SECTION 3: SALES PERFORMANCE ---
    currentY = doc.lastAutoTable.finalY + 15;
    doc.setFontSize(12);
    doc.text('3. Sales Performance Analysis', 14, currentY);

    autoTable(doc, {
      startY: currentY + 5,
      head: [['Description', 'Amount (KSh)']],
      body: [
        ['Actual Sales', formatKsh(num(actualSales))],
        ['System Sales (Original)', formatKsh(num(systemSales))],
        ['Less: Credit Sales Included', `(${formatKsh(num(creditSales))})`],
        ['Adjusted System Sales', formatKsh(adjustedSystemSales)],
        ['Sales Variance', formatKsh(stockAndSalesResults.salesVariance)],
        ['Sales Variance Percentage', formatPct(stockAndSalesResults.salesVariancePercentage)],
      ],
      theme: 'striped',
      headStyles: { fillColor: [41, 128, 185] },
      styles: { fontSize: 10 }
    });

    // --- SECTION 4: RECONCILIATION ---
    currentY = doc.lastAutoTable.finalY + 15;
    doc.setFontSize(12);
    doc.text('4. Stock Loss & Sales Variance Reconciliation', 14, currentY);

    autoTable(doc, {
      startY: currentY + 5,
      head: [['Calculation Step', 'Amount (KSh)']],
      body: [
        ['Gross Stock Shortage', formatKsh(stockAndSalesResults.grossStockShortage)],
        ['Positive Sales Variance Available', formatKsh(stockAndSalesResults.positiveSalesVariance)],
        ['Sales Variance Applied to Offset', formatKsh(stockAndSalesResults.salesOffset)],
        ['Residual Stock Loss', formatKsh(stockAndSalesResults.residualStockLoss)],
        ['Remaining Sales Surplus', formatKsh(stockAndSalesResults.remainingSalesSurplus)],
      ],
      theme: 'grid',
      headStyles: { fillColor: [192, 57, 43] }, // Red for loss
      styles: { fontSize: 10 }
    });

    // --- SECTION 5: DEBT MOVEMENT ---
    currentY = doc.lastAutoTable.finalY + 15;
    doc.setFontSize(12);
    doc.text('5. Branch Debt Movement', 14, currentY);

    autoTable(doc, {
      startY: currentY + 5,
      head: [['Description', 'Date', 'Amount (KSh)']],
      body: [
        ['Opening Branch Debt', openingDebtDate, formatKsh(num(openingDebt))],
        ['Original Closing Debt', closingDebtDate, formatKsh(num(originalClosingDebt))],
        ['Gross Debt Reduction', '-', formatKsh(debtResults.grossDebtReduction)],
        ['Add: Residual Stock Loss', '-', formatKsh(stockAndSalesResults.residualStockLoss)],
        ['Adjusted Closing Debt', '-', formatKsh(debtResults.adjustedClosingDebt)],
        ['Net Debt Reduction', '-', formatKsh(debtResults.netDebtReduction)],
        ['Net Debt Reduction Percentage', '-', formatPct(debtResults.debtReductionPercentage)],
      ],
      theme: 'striped',
      headStyles: { fillColor: [39, 174, 96] }, // Green for debt
      styles: { fontSize: 10 }
    });

    // --- SECTION 6: APPROVAL ---
    currentY = doc.lastAutoTable.finalY + 20;
    
    // Check if we need a new page for signatures
    if (currentY > pageHeight - 50) {
      doc.addPage();
      currentY = 20;
    }

    doc.setFontSize(12);
    doc.text('6. Approval and Audit Trail', 14, currentY);

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Prepared by: ${preparedBy || '_______________________'}`, 14, currentY + 15);
    doc.text(`Date: ${today}`, 14, currentY + 22);

    doc.text(`Reviewed by: ${reviewedBy || '_______________________'}`, 120, currentY + 15);
    doc.text(`Date: ___________________`, 120, currentY + 22);

    // Footer
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Report generated on ${new Date().toLocaleString()} | Mediocare Pharmaceuticals Ltd`, pageWidth / 2, pageHeight - 10, { align: 'center' });

    doc.save(`${branchName}_Financial_Report.pdf`);
  };

  const inputStyle = { width: '100%', padding: '8px', marginBottom: '15px', border: '1px solid #ccc', borderRadius: '4px' };
  const labelStyle = { display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '14px' };
  const cardStyle = { padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', marginBottom: '20px', border: '1px solid #ddd' };

  return (
    <main style={{ maxWidth: '1000px', margin: '40px auto', fontFamily: 'system-ui', padding: '0 20px' }}>
      <h1 style={{ borderBottom: '2px solid #333', paddingBottom: '10px' }}>Mediocare Stock Control</h1>
      
      <div style={{ marginBottom: '20px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
        <div>
          <label style={labelStyle}>Select Branch</label>
          <select value={selectedBranch} onChange={(e) => setSelectedBranch(e.target.value)} style={{ padding: '10px', width: '300px', fontSize: '16px' }}>
            <option value="">-- Choose a Branch --</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Reporting Period Start</label>
          <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} style={{ padding: '10px', width: '200px', fontSize: '16px' }} />
        </div>
        <div>
          <label style={labelStyle}>Reporting Period End</label>
          <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} style={{ padding: '10px', width: '200px', fontSize: '16px' }} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        <div>
          <div style={cardStyle}>
            <h3>1. Stock Data</h3>
            <label style={labelStyle}>Opening Stock Valuation Date</label>
            <input type="date" value={valuationDate} onChange={e => setValuationDate(e.target.value)} style={inputStyle} />
            <label style={labelStyle}>Opening Stock (KSh)</label>
            <input type="number" value={openingStock} onChange={e => setOpeningStock(e.target.value)} style={inputStyle} />
            
            <label style={labelStyle}>Physical Stock Count Date</label>
            <input type="date" value={physicalCountDate} onChange={e => setPhysicalCountDate(e.target.value)} style={inputStyle} />
            <label style={labelStyle}>Physical Stock (KSh)</label>
            <input type="number" value={physicalStock} onChange={e => setPhysicalStock(e.target.value)} style={inputStyle} />
          </div>

          <div style={cardStyle}>
            <h3>2. Sales Data</h3>
            <label style={labelStyle}>Actual Sales (KSh)</label>
            <input type="number" value={actualSales} onChange={e => setActualSales(e.target.value)} style={inputStyle} />
            <label style={labelStyle}>System Sales (KSh)</label>
            <input type="number" value={systemSales} onChange={e => setSystemSales(e.target.value)} style={inputStyle} />
            <label style={labelStyle}>Credit Sales included (KSh)</label>
            <input type="number" value={creditSales} onChange={e => setCreditSales(e.target.value)} style={inputStyle} />
          </div>

          <div style={cardStyle}>
            <h3>3. Debt Data</h3>
            <label style={labelStyle}>Opening Debt Date</label>
            <input type="date" value={openingDebtDate} onChange={e => setOpeningDebtDate(e.target.value)} style={inputStyle} />
            <label style={labelStyle}>Opening Debt (KSh)</label>
            <input type="number" value={openingDebt} onChange={e => setOpeningDebt(e.target.value)} style={inputStyle} />

            <label style={labelStyle}>Closing Debt Date</label>
            <input type="date" value={closingDebtDate} onChange={e => setClosingDebtDate(e.target.value)} style={inputStyle} />
            <label style={labelStyle}>Original Closing Debt (KSh)</label>
            <input type="number" value={originalClosingDebt} onChange={e => setOriginalClosingDebt(e.target.value)} style={inputStyle} />
          </div>

          <div style={cardStyle}>
            <h3>4. Approval Details</h3>
            <label style={labelStyle}>Prepared By</label>
            <input type="text" value={preparedBy} onChange={e => setPreparedBy(e.target.value)} style={inputStyle} placeholder="Staff Name" />
            <label style={labelStyle}>Reviewed By</label>
            <input type="text" value={reviewedBy} onChange={e => setReviewedBy(e.target.value)} style={inputStyle} placeholder="Manager Name" />
          </div>
        </div>

        <div>
          <div style={{ ...cardStyle, backgroundColor: '#eef2f5' }}>
            <h3>Reconciliation Results</h3>
            <p><strong>Gross Stock Variance:</strong> KSh {formatKsh(stockAndSalesResults.grossStockVariance)} ({formatPct(stockAndSalesResults.stockVariancePercentage)})</p>
            <p><strong>Sales Variance:</strong> KSh {formatKsh(stockAndSalesResults.salesVariance)} ({formatPct(stockAndSalesResults.salesVariancePercentage)})</p>
            <hr style={{ margin: '15px 0', borderTop: '1px solid #ccc' }} />
            <p><strong>Gross Stock Shortage:</strong> KSh {formatKsh(stockAndSalesResults.grossStockShortage)}</p>
            <p><strong>Sales Offset Applied:</strong> KSh {formatKsh(stockAndSalesResults.salesOffset)}</p>
            <p style={{ color: stockAndSalesResults.residualStockLoss > 0 ? 'red' : 'green', fontSize: '18px' }}>
              <strong>Residual Stock Loss:</strong> KSh {formatKsh(stockAndSalesResults.residualStockLoss)}
            </p>
            <hr style={{ margin: '15px 0', borderTop: '1px solid #ccc' }} />
            <p><strong>Adjusted Closing Debt:</strong> KSh {formatKsh(debtResults.adjustedClosingDebt)}</p>
            <p style={{ color: 'green', fontSize: '18px' }}><strong>Net Debt Reduction:</strong> KSh {formatKsh(debtResults.netDebtReduction)} ({formatPct(debtResults.debtReductionPercentage)})</p>
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <button onClick={handleSave} disabled={isSaving} style={{ width: '100%', padding: '15px', backgroundColor: '#0070f3', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
              {isSaving ? 'Saving...' : 'Save Draft to Database'}
            </button>
            <button onClick={generatePDF} style={{ width: '100%', padding: '15px', backgroundColor: '#000', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
              Download Professional PDF Report
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
