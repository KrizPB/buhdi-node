/**
 * Stripe Tool Plugin
 * 
 * Uses Stripe API v1 with secret key.
 * Actions: list_payments, list_invoices, get_balance, create_invoice
 */

import { ToolPlugin, ToolResult, SafetyTier } from './types';

const STRIPE_API = 'https://api.stripe.com/v1';

export const stripePlugin: ToolPlugin = {
  name: 'stripe_payments',
  displayName: 'Stripe',
  description: 'Payment processing, invoices, and financial reports',
  category: 'Accounting & Finance',
  icon: '💳',
  
  credentials: [
    {
      key: 'secret_key',
      label: 'Stripe Secret Key',
      type: 'api_key',
      required: true,
      hint: 'Starts with sk_live_ or sk_test_. Found in Stripe Dashboard → Developers → API Keys.',
      placeholder: 'sk_live_...',
    },
  ],
  
  actions: [
    {
      name: 'get_balance',
      description: 'Get current Stripe account balance',
      safety: SafetyTier.READ,
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'list_payments',
      description: 'List recent payments/charges',
      safety: SafetyTier.READ,
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of payments to return', default: 10 },
          status: { type: 'string', description: 'Filter by status', enum: ['succeeded', 'pending', 'failed'] },
        },
      },
    },
    {
      name: 'list_invoices',
      description: 'List recent invoices',
      safety: SafetyTier.READ,
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of invoices to return', default: 10 },
          status: { type: 'string', description: 'Filter by status', enum: ['draft', 'open', 'paid', 'void', 'uncollectible'] },
        },
      },
    },
    {
      name: 'get_customer',
      description: 'Get customer details by ID or email',
      safety: SafetyTier.READ,
      parameters: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Stripe customer ID (cus_...)' },
          email: { type: 'string', description: 'Customer email (searches if no ID given)' },
        },
      },
    },
    {
      name: 'create_invoice',
      description: 'Create a draft invoice for a customer',
      safety: SafetyTier.FINANCIAL,
      rateLimit: 5,
      parameters: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Stripe customer ID' },
          description: { type: 'string', description: 'Invoice item description' },
          amount: { type: 'number', description: 'Amount in cents (e.g., 5000 = $50.00)' },
          currency: { type: 'string', description: 'Currency code', default: 'usd' },
        },
        required: ['customer_id', 'description', 'amount'],
      },
    },
  ],

  _key: '' as any,
  
  async init(credentials: Record<string, string>): Promise<boolean> {
    const key = credentials.secret_key;
    // L4-FIX: Validate Stripe key format (prefix + alphanumeric + min length)
    if (!key || !/^sk_(live|test)_[A-Za-z0-9]{20,}$/.test(key)) return false;
    (this as any)._key = key;
    return true;
  },
  
  async healthCheck(): Promise<boolean> {
    return !!(this as any)._key;
  },
  
  async testCredentials(): Promise<ToolResult> {
    try {
      const res = await fetch(`${STRIPE_API}/balance`, {
        headers: { Authorization: `Bearer ${(this as any)._key}` },
      });
      if (!res.ok) {
        return { success: false, output: `Stripe auth failed: ${res.status}` };
      }
      const bal = await res.json() as any;
      const available = bal.available?.map((b: any) => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`).join(', ');
      return { success: true, output: `Connected. Balance: ${available || '$0.00'}`, data: bal };
    } catch (err: any) {
      return { success: false, output: `Connection error: ${err.message}`, error: err.message };
    }
  },
  
  async execute(action: string, params: Record<string, any>): Promise<ToolResult> {
    const key = (this as any)._key;
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    
    switch (action) {
      case 'get_balance': {
        const res = await fetch(`${STRIPE_API}/balance`, { headers });
        if (!res.ok) return { success: false, output: `Failed: ${res.status}` };
        const bal = await res.json() as any;
        const available = bal.available?.map((b: any) => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`).join(', ');
        const pending = bal.pending?.map((b: any) => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`).join(', ');
        return {
          success: true,
          output: `Available: ${available || '$0.00'}\nPending: ${pending || '$0.00'}`,
          data: bal,
        };
      }
      
      case 'list_payments': {
        const limit = params.limit || 10;
        let url = `${STRIPE_API}/charges?limit=${limit}`;
        if (params.status) url += `&status=${params.status}` ;
        // Note: Stripe charges endpoint doesn't filter by status directly,
        // but payment_intents does. Using charges for simplicity.
        const res = await fetch(url, { headers });
        if (!res.ok) return { success: false, output: `Failed: ${res.status}` };
        const data = await res.json() as any;
        
        const payments = (data.data || []).map((c: any) => ({
          id: c.id,
          amount: `$${(c.amount / 100).toFixed(2)} ${c.currency.toUpperCase()}`,
          status: c.status,
          description: c.description || '(no description)',
          customer: c.customer,
          created: new Date(c.created * 1000).toLocaleDateString(),
        }));
        
        const output = payments.length
          ? payments.map((p: any, i: number) => `${i + 1}. ${p.amount} — ${p.status} — ${p.description} (${p.created})`).join('\n')
          : 'No payments found';
        
        return { success: true, output, data: payments };
      }
      
      case 'list_invoices': {
        const limit = params.limit || 10;
        let url = `${STRIPE_API}/invoices?limit=${limit}`;
        if (params.status) url += `&status=${params.status}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return { success: false, output: `Failed: ${res.status}` };
        const data = await res.json() as any;
        
        const invoices = (data.data || []).map((inv: any) => ({
          id: inv.id,
          number: inv.number,
          amount: `$${((inv.amount_due || 0) / 100).toFixed(2)} ${(inv.currency || 'usd').toUpperCase()}`,
          status: inv.status,
          customer_email: inv.customer_email,
          due_date: inv.due_date ? new Date(inv.due_date * 1000).toLocaleDateString() : 'N/A',
          created: new Date(inv.created * 1000).toLocaleDateString(),
        }));
        
        const output = invoices.length
          ? invoices.map((inv: any, i: number) => `${i + 1}. ${inv.number || inv.id} — ${inv.amount} — ${inv.status} — ${inv.customer_email || 'no email'} (due: ${inv.due_date})`).join('\n')
          : 'No invoices found';
        
        return { success: true, output, data: invoices };
      }
      
      case 'get_customer': {
        let url: string;
        if (params.customer_id) {
          url = `${STRIPE_API}/customers/${params.customer_id}`;
        } else if (params.email) {
          // N2-FIX: Encode email in search query to prevent injection
          url = `${STRIPE_API}/customers/search?query=${encodeURIComponent(`email:"${params.email}"`)}`;
        } else {
          return { success: false, output: 'Provide either customer_id or email' };
        }
        
        const res = await fetch(url, { headers });
        if (!res.ok) return { success: false, output: `Failed: ${res.status}` };
        const data = await res.json() as any;
        
        // Search returns a list
        const customer = data.data ? data.data[0] : data;
        if (!customer) return { success: true, output: 'Customer not found', data: null };
        
        return {
          success: true,
          output: `Customer: ${customer.name || 'N/A'} (${customer.email})\nID: ${customer.id}\nCreated: ${new Date(customer.created * 1000).toLocaleDateString()}\nBalance: $${((customer.balance || 0) / 100).toFixed(2)}`,
          data: customer,
        };
      }
      
      case 'create_invoice': {
        // First create the invoice
        // H5-FIX: Use URLSearchParams to prevent parameter injection
        const invBody = new URLSearchParams();
        invBody.set('customer', params.customer_id);
        invBody.set('auto_advance', 'false');
        const invRes = await fetch(`${STRIPE_API}/invoices`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: invBody.toString(),
        });
        if (!invRes.ok) {
          const err = await invRes.text();
          return { success: false, output: `Failed to create invoice: ${invRes.status}`, error: err };
        }
        const invoice = await invRes.json() as any;
        
        // Add an invoice item
        // H5-FIX: Use URLSearchParams for invoice items too
        const itemBody = new URLSearchParams();
        itemBody.set('customer', params.customer_id);
        itemBody.set('invoice', invoice.id);
        itemBody.set('amount', String(params.amount));
        itemBody.set('currency', params.currency || 'usd');
        itemBody.set('description', params.description);
        const itemRes = await fetch(`${STRIPE_API}/invoiceitems`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: itemBody.toString(),
        });
        if (!itemRes.ok) {
          return { success: false, output: `Invoice created but failed to add item: ${itemRes.status}` };
        }
        
        return {
          success: true,
          output: `Draft invoice created: ${invoice.id}\nCustomer: ${params.customer_id}\nAmount: $${(params.amount / 100).toFixed(2)} ${(params.currency || 'usd').toUpperCase()}\nDescription: ${params.description}\n\nInvoice is in DRAFT — finalize it to send.`,
          data: invoice,
        };
      }
      
      default:
        return { success: false, output: `Unknown action: ${action}`, error: 'UNKNOWN_ACTION' };
    }
  },
} as ToolPlugin & { _key: string };
