const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');
const Airtable = require('airtable');

const app = express();
const port = process.env.PORT || 3000;

// Initialize APIs
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base('appUNIsu8KgvOlmi0');

// Gmail transporter
const gmailTransporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// Middleware
app.use(express.json());
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));

// Logging system
let logs = [];
const addLog = (message, level = 'info') => {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message
  };
  logs.push(logEntry);
  console.log(`[${level.toUpperCase()}] ${message}`);
  // Keep only last 100 logs
  if (logs.length > 100) logs = logs.slice(-100);
};

// Helper function to send email alert
async function sendEmailAlert(paymentData) {
  try {
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
      subject: '🚨 Stripe Payment Failed Alert',
      html: `
        <h2>Payment Failure Alert</h2>
        <p><strong>Customer:</strong> ${paymentData.customerEmail || 'Unknown'}</p>
        <p><strong>Amount:</strong> $${(paymentData.amount / 100).toFixed(2)} ${paymentData.currency.toUpperCase()}</p>
        <p><strong>Failure Reason:</strong> ${paymentData.failureReason}</p>
        <p><strong>Payment ID:</strong> ${paymentData.paymentId}</p>
        <p><strong>Time:</strong> ${paymentData.timestamp}</p>
        <p><strong>Customer ID:</strong> ${paymentData.customerId || 'N/A'}</p>
        
        <hr>
        <p>This alert was generated automatically by your Stripe Failed Payments Monitor.</p>
      `
    };

    await gmailTransporter.sendMail(mailOptions);
    addLog(`Email alert sent successfully for payment ${paymentData.paymentId}`);
  } catch (error) {
    addLog(`Failed to send email alert: ${error.message}`, 'error');
  }
}

// Helper function to log to Airtable
async function logToAirtable(paymentData) {
  try {
    const record = {
      'Payment ID': paymentData.paymentId,
      'Customer Email': paymentData.customerEmail || 'Unknown',
      'Customer ID': paymentData.customerId || 'N/A',
      'Amount': (paymentData.amount / 100).toFixed(2),
      'Currency': paymentData.currency.toUpperCase(),
      'Failure Reason': paymentData.failureReason,
      'Timestamp': paymentData.timestamp,
      'Status': 'Failed',
      'Alert Sent': 'Yes'
    };

    await base('Failed Payments').create(record);
    addLog(`Payment failure logged to Airtable: ${paymentData.paymentId}`);
  } catch (error) {
    addLog(`Failed to log to Airtable: ${error.message}`, 'error');
    if (error.message.includes('NOT_FOUND')) {
      addLog('Please create a "Failed Payments" table in your Growth AI Airtable base with the following fields:', 'warn');
      addLog('- Payment ID (Single line text)', 'warn');
      addLog('- Customer Email (Email)', 'warn');
      addLog('- Customer ID (Single line text)', 'warn');
      addLog('- Amount (Number)', 'warn');
      addLog('- Currency (Single line text)', 'warn');
      addLog('- Failure Reason (Long text)', 'warn');
      addLog('- Timestamp (Date)', 'warn');
      addLog('- Status (Single select: Failed)', 'warn');
      addLog('- Alert Sent (Single select: Yes, No)', 'warn');
    }
  }
}

// Process failed payment
async function processFailedPayment(paymentIntent) {
  const paymentData = {
    paymentId: paymentIntent.id,
    customerId: paymentIntent.customer,
    customerEmail: null,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    failureReason: paymentIntent.last_payment_error?.message || 'Unknown error',
    timestamp: new Date().toISOString()
  };

  // Try to get customer email if customer ID exists
  if (paymentIntent.customer) {
    try {
      const customer = await stripe.customers.retrieve(paymentIntent.customer);
      paymentData.customerEmail = customer.email;
    } catch (error) {
      addLog(`Could not retrieve customer email: ${error.message}`, 'warn');
    }
  }

  addLog(`Processing failed payment: ${paymentData.paymentId} - $${(paymentData.amount / 100).toFixed(2)}`);

  // Send email alert
  await sendEmailAlert(paymentData);

  // Log to Airtable
  await logToAirtable(paymentData);
}

// Routes

// GET / - Status and available endpoints
app.get('/', (req, res) => {
  res.json({
    service: 'Stripe Failed Payments Monitor',
    status: 'running',
    endpoints: {
      'GET /': 'This status page',
      'GET /health': 'Health check',
      'GET /logs': 'View recent logs',
      'POST /test': 'Manual test run',
      'POST /webhook': 'Stripe webhook endpoint',
      'GET /webhook/info': 'Webhook configuration info'
    },
    lastStarted: new Date().toISOString()
  });
});

// GET /health - Health check
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    checks: {}
  };

  // Test Stripe connection
  try {
    await stripe.balance.retrieve();
    health.checks.stripe = 'connected';
  } catch (error) {
    health.checks.stripe = 'error';
    health.status = 'unhealthy';
  }

  // Test Gmail connection
  try {
    await gmailTransporter.verify();
    health.checks.gmail = 'connected';
  } catch (error) {
    health.checks.gmail = 'error';
    health.status = 'unhealthy';
  }

  // Test Airtable connection
  try {
    await base('Failed Payments').select({ maxRecords: 1 }).firstPage();
    health.checks.airtable = 'connected';
  } catch (error) {
    health.checks.airtable = 'table_needs_creation';
  }

  res.json(health);
});

// GET /logs - View recent logs
app.get('/logs', (req, res) => {
  res.json({
    logs: logs.slice(-50), // Return last 50 logs
    total: logs.length
  });
});

// POST /test - Manual test run
app.post('/test', async (req, res) => {
  addLog('Manual test initiated');
  
  const testPaymentData = {
    paymentId: 'pi_test_' + Date.now(),
    customerId: 'cus_test_customer',
    customerEmail: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
    amount: 2500, // $25.00
    currency: 'usd',
    failureReason: 'Test failure - insufficient funds',
    timestamp: new Date().toISOString()
  };

  try {
    await sendEmailAlert(testPaymentData);
    await logToAirtable(testPaymentData);
    
    addLog('Test completed successfully');
    res.json({
      success: true,
      message: 'Test alert sent and logged successfully',
      testData: testPaymentData
    });
  } catch (error) {
    addLog(`Test failed: ${error.message}`, 'error');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /webhook/info - Webhook configuration info
app.get('/webhook/info', (req, res) => {
  res.json({
    webhookUrl: `${req.protocol}://${req.get('host')}/webhook`,
    eventsToSubscribe: [
      'payment_intent.payment_failed',
      'invoice.payment_failed',
      'charge.failed'
    ],
    instructions: 'Add this webhook URL to your Stripe Dashboard under Developers > Webhooks'
  });
});

// POST /webhook - Stripe webhook endpoint
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    addLog(`Webhook signature verification failed: ${err.message}`, 'error');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  addLog(`Received webhook event: ${event.type}`);

  // Handle payment failure events
  if (event.type === 'payment_intent.payment_failed') {
    await processFailedPayment(event.data.object);
  } else if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    if (invoice.payment_intent) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(invoice.payment_intent);
        await processFailedPayment(paymentIntent);
      } catch (error) {
        addLog(`Error processing invoice payment failure: ${error.message}`, 'error');
      }
    }
  } else if (event.type === 'charge.failed') {
    const charge = event.data.object;
    const paymentData = {
      paymentId: charge.id,
      customerId: charge.customer,
      customerEmail: charge.billing_details?.email || null,
      amount: charge.amount,
      currency: charge.currency,
      failureReason: charge.failure_message || 'Unknown error',
      timestamp: new Date().toISOString()
    };

    await sendEmailAlert(paymentData);
    await logToAirtable(paymentData);
  }

  res.json({ received: true });
});

// Start server
app.listen(port, () => {
  addLog(`Stripe Failed Payments Monitor started on port ${port}`);
  addLog('Ready to monitor failed payments and send alerts');
});

module.exports = app;