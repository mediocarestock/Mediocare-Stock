'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { calculateStockAndSales, calculateDebt } from '../lib/calculations';

export default function Home() {
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');

  // Form State
  const [openingStock, setOpeningStock] = useState('');
  const [physicalStock, setPhysicalStock] = useState('');
  const [actualSales, setActualSales] = useState('');
  const [systemSales, setSystemSales] = useState('');
  const [creditSales, setCreditSales] = useState('');
  const [openingDebt, setOpeningDebt] = useState('');
  const [originalClosingDebt, setOriginalClosingDebt] = useState('');

  // Fetch branches on load
  useEffect(() => {
    async function getBranches() {
      const { data } = await supabase.from('branches').select('*').order('name');
      if (data) setBranches(data);
    }
    getBranches();
  }, []);

  // Parse inputs to numbers
  const num = (val) => parseFloat(val) || 0;

  // Live Calculations
  const adjustedSystemSales = num(systemSales) - num(creditSales);
  const stockAndSalesResults = calculateStockAndSales(
    num(openingStock),
    num(physicalStock),
    num(actualSales),
    adjustedSystemSales
  );
  
  const debtResults = calculateDebt(
    num(openingDebt),
    num(originalClosingDebt),
    stockAndSalesResults.residualStockLoss
  );

  const formatKsh = (amount) => {
    return new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  };

  const inputStyle = { width: '100%', padding: '8px', marginBottom: '15px', border: '1px solid #ccc', borderRadius: '4px' };
  const labelStyle = { display: 'block', marginBottom: '5px', fontWeight: 'bold', fontSize: '14px' };
  const cardStyle = { padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px', marginBottom: '20px', border: '1px solid #ddd' };

  return (
    <main style={{ maxWidth: '1000px', margin: '40px auto', fontFamily: 'system-ui', padding: '0 20px' }}>
      <h1 style={{ borderBottom: '2px solid #333', paddingBottom: '10px' }}>Mediocare Stock Control</h1>
      
      <div style={{ marginBottom: '20px' }}>
        <label style={labelStyle}>Select Branch</label>
        <select 
          value={selectedBranch} 
          onChange={(e) => setSelectedBranch(e.target.value)}
          style={{ padding: '10px', width: '100%', maxWidth: '300px', fontSize: '16px' }}
        >
          <option value="">-- Choose a Branch --</option>
          {branches.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        
        {/* INPUT FORMS */}
        <div>
          <div style={cardStyle}>
            <h3>1. Stock Data</h3>
            <label style={labelStyle}>Opening Stock (KSh)</label>
            <input type="number" value={openingStock} onChange={e => setOpeningStock(e.target.value)} style={inputStyle} placeholder="e.g. 500000" />
            
            <label style={labelStyle}>Physical Stock after Stock Take (KSh)</label>
            <input type="number" value={physicalStock} onChange={e => setPhysicalStock(e.target.value)} style={inputStyle} placeholder="e.g. 480000" />
          </div>

          <div style={cardStyle}>
            <h3>2. Sales Data</h3>
            <label style={labelStyle}>Actual Sales (KSh)</label>
            <input type="number" value={actualSales} onChange={e => setActualSales(e.target.value)} style={inputStyle} placeholder="e.g. 200000" />

            <label style={labelStyle}>System Sales (KSh)</label>
            <input type="number" value={systemSales} onChange={e => setSystemSales(e.target.value)} style={inputStyle} placeholder="e.g. 185000" />

            <label style={labelStyle}>Credit Sales included in System Sales (KSh)</label>
            <input type="number" value={creditSales} onChange={e => setCreditSales(e.target.value)} style={inputStyle} placeholder="e.g. 0" />
          </div>

          <div style={cardStyle}>
            <h3>3. Debt Data</h3>
            <label style={labelStyle}>Opening Debt (KSh)</label>
            <input type="number" value={openingDebt} onChange={e => setOpeningDebt(e.target.value)} style={inputStyle} placeholder="e.g. 1000000" />

            <label style={labelStyle}>Original Closing Debt (KSh)</label>
            <input type="number" value={originalClosingDebt} onChange={e => setOriginalClosingDebt(e.target.value)} style={inputStyle} placeholder="e.g. 900000" />
          </div>
        </div>

        {/* LIVE RESULTS PANEL */}
        <div>
          <div style={{ ...cardStyle, backgroundColor: '#eef2f5' }}>
            <h3>Reconciliation Results</h3>
            
            <p><strong>Gross Stock Variance:</strong> KSh {formatKsh(stockAndSalesResults.grossStockVariance)}</p>
            <p><strong>Sales Variance:</strong> KSh {formatKsh(stockAndSalesResults.salesVariance)}</p>
            
            <hr style={{ margin: '15px 0', borderTop: '1px solid #ccc' }} />
            
            <p><strong>Gross Stock Shortage:</strong> KSh {formatKsh(stockAndSalesResults.grossStockShortage)}</p>
            <p><strong>Sales Offset Applied:</strong> KSh {formatKsh(stockAndSalesResults.salesOffset)}</p>
            
            <p style={{ color: stockAndSalesResults.residualStockLoss > 0 ? 'red' : 'green', fontSize: '18px' }}>
              <strong>Residual Stock Loss:</strong> KSh {formatKsh(stockAndSalesResults.residualStockLoss)}
            </p>
            
            <p style={{ color: stockAndSalesResults.remainingSalesSurplus > 0 ? 'blue' : 'black' }}>
              <strong>Remaining Sales Surplus:</strong> KSh {formatKsh(stockAndSalesResults.remainingSalesSurplus)}
            </p>

            <hr style={{ margin: '15px 0', borderTop: '1px solid #ccc' }} />

            <p><strong>Gross Debt Reduction:</strong> KSh {formatKsh(debtResults.grossDebtReduction)}</p>
            <p><strong>Adjusted Closing Debt:</strong> KSh {formatKsh(debtResults.adjustedClosingDebt)}</p>
            <p style={{ color: 'green', fontSize: '18px' }}>
              <strong>Net Debt Reduction:</strong> KSh {formatKsh(debtResults.netDebtReduction)}
            </p>
          </div>
          
          <button style={{ width: '100%', padding: '15px', backgroundColor: '#000', color: '#fff', fontSize: '16px', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
            Save Draft Report (Coming in Phase 4)
          </button>
        </div>

      </div>
    </main>
  );
}
