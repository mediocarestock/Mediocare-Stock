'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadMessages() {
    setLoading(true);
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      alert(error.message);
    } else {
      setMessages(data ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadMessages();
  }, []);

  async function addMessage(e) {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed) return;

    const { error } = await supabase
      .from('messages')
      .insert({ content: trimmed });

    if (error) {
      alert(error.message);
      return;
    }
    setContent('');
    await loadMessages();
  }

  return (
    <main style={{ maxWidth: 640, margin: '40px auto', fontFamily: 'system-ui' }}>
      <h1>Medicare Stock App</h1>
      <form onSubmit={addMessage} style={{ display: 'flex', gap: 8 }}>
        <input
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write a message"
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" style={{ padding: '8px 16px' }}>Add</button>
      </form>

      {loading ? (
        <p>Loading...</p>
      ) : (
        <ul>
          {messages.map((m) => (
            <li key={m.id}>
              {m.content} <small>{new Date(m.created_at).toLocaleString()}</small>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
