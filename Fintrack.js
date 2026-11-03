/**
 * FINTRACK - DAILY FINANCIAL HEALTH EMAIL
 * Firebase Cloud Functions v2 + Resend
 *
 * Schedule: Every day, 08:00 AM
 * Timezone: Asia/Kolkata
 * Recipient: Verified Firebase account email
 *
 * Existing FinTrack Firestore portfolio:
 * users/{uid}/portfolio/main
 *
 * Email preferences:
 * users/{uid}/settings/dailyFinancialEmail
 *
 * Required packages:
 * firebase-admin
 * firebase-functions
 * resend
 *
 * Deploy:
 * firebase deploy --only functions
 */

'use strict';

const admin = require('firebase-admin');

const {
  onSchedule
} = require('firebase-functions/v2/scheduler');

const {
  defineSecret
} = require('firebase-functions/params');

const logger = require('firebase-functions/logger');

const { Resend } = require('resend');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

const TIME_ZONE = 'Asia/Kolkata';

const FROM_EMAIL =
  'FinTrack <reports@YOUR-VERIFIED-DOMAIN.com>';

const INR = value =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  }).format(Number(value) || 0);

const num = value => {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
};

const positive = value => Math.max(0, num(value));

const safeArray = value =>
  Array.isArray(value) ? value.filter(Boolean) : [];

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

const norm = value =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');


// --------------------------------------------------
// DATE HELPERS
// --------------------------------------------------

function localDateParts(date = new Date()) {

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const p = Object.fromEntries(
    parts.map(item => [item.type, item.value])
  );

  return {
    key: `${p.year}-${p.month}-${p.day}`,
    monthKey: `${p.year}-${p.month}`
  };
}

function transactionDate(record) {

  const raw =
    record.date ||
    record.transactionDate ||
    record.createdAt ||
    record.timestamp;

  if (!raw) return null;

  const date = new Date(raw);

  return Number.isNaN(date.getTime())
    ? null
    : date;
}

function transactionMonth(record) {

  const date = transactionDate(record);

  if (!date) return '';

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit'
  }).format(date);
}


// --------------------------------------------------
// FINTRACK TRANSACTION CLASSIFICATION
// Mirrors v115 helpers.
// --------------------------------------------------

function txType(record) {

  return String(
    record?.type ??
    record?.kind ??
    record?.transactionType ??
    ''
  ).trim().toLowerCase();
}

function txSource(record) {

  return String(
    record?.account ??
    record?.fromAccount ??
    record?.sourceAccount ??
    record?.from ??
    ''
  ).trim();
}

function txDestination(record) {

  return String(
    record?.toAccount ??
    record?.destinationAccount ??
    record?.targetAccount ??
    record?.to ??
    ''
  ).trim();
}

function txAmount(record) {

  return num(record?.amount);
}

function isTransfer(record) {

  return [
    'transfer',
    'internal transfer'
  ].includes(txType(record));
}

function isIncome(record) {

  return [
    'income',
    'inflow'
  ].includes(txType(record));
}

function isExpense(record) {

  return [
    'expense',
    'spent',
    'outflow'
  ].includes(txType(record));
}


// --------------------------------------------------
// EXACT FINTRACK ACCOUNT BALANCE LOGIC
// Mirrors calculateAccountBalances() in v115.
// --------------------------------------------------

function calculateAccountBalances(portfolio) {

  const accounts = safeArray(portfolio.accountsList);

  const records = safeArray(portfolio.expenseRecords);

  const balanceMap = {};

  accounts.forEach(account => {

    if (!account || !account.name) return;

    balanceMap[account.name] =
      num(account.initialBalance);

  });

  records.forEach(record => {

    const amount = txAmount(record);

    const type = txType(record);

    const source = txSource(record);

    const destination = txDestination(record);

    if (['income', 'inflow'].includes(type)) {

      if (source in balanceMap) {
        balanceMap[source] += amount;
      }

    } else if (
      ['expense', 'spent', 'outflow'].includes(type)
    ) {

      if (source in balanceMap) {
        balanceMap[source] -= amount;
      }

    } else if (isTransfer(record)) {

      if (source in balanceMap) {
        balanceMap[source] -= amount;
      }

      if (destination in balanceMap) {
        balanceMap[destination] += amount;
      }

    }

  });

  return balanceMap;
}


// --------------------------------------------------
// LATEST LOAN SNAPSHOT
// Mirrors the latest-per-loan principle in v115.
// --------------------------------------------------

function getLatestLoans(debtRecords) {

  const latestByLoan = {};

  safeArray(debtRecords).forEach(record => {

    const key = String(
      record.metric ||
      record.id ||
      record.category ||
      ''
    );

    if (!key) return;

    if (
      !latestByLoan[key] ||
      String(record.month || '') >
      String(latestByLoan[key].month || '')
    ) {

      latestByLoan[key] = record;

    }

  });

  return Object.values(latestByLoan);
}


// --------------------------------------------------
// FINANCIAL CALCULATION
// --------------------------------------------------

function calculateFinancialHealth(portfolio, preferences) {

  const now = new Date();

  const period = localDateParts(now);

  const records = safeArray(portfolio.expenseRecords);

  const monthRows = records.filter(record =>
    transactionMonth(record) === period.monthKey
  );

  // Internal transfers are automatically excluded
  // from income and expense totals.

  const income = monthRows
    .filter(isIncome)
    .reduce((sum, record) =>
      sum + txAmount(record), 0);

  const spent = monthRows
    .filter(isExpense)
    .reduce((sum, record) =>
      sum + txAmount(record), 0);

  const netCashFlow = income - spent;


  // ----------------------------------------------
  // ACCOUNT BALANCES
  // ----------------------------------------------

  const accountBalances =
    calculateAccountBalances(portfolio);

  const availableCash = Object
    .values(accountBalances)
    .reduce((sum, balance) =>
      sum + num(balance), 0);


  // ----------------------------------------------
  // MONTHLY BUDGETS
  // ----------------------------------------------

  const monthlyBudgets =
    portfolio.monthlyBudgets || {};

  const budgets = Array.isArray(
    monthlyBudgets[period.monthKey]
  )
    ? monthlyBudgets[period.monthKey]
    : [];

  const actualByCategory = {};

  monthRows
    .filter(isExpense)
    .forEach(record => {

      const category =
        norm(record.category) || 'uncategorised';

      actualByCategory[category] =
        (actualByCategory[category] || 0) +
        txAmount(record);

    });


  const categories = budgets.map(budget => {

    const category =
      String(budget.category || 'Uncategorised');

    const key = norm(category);

    const actual =
      actualByCategory[key] || 0;

    const required =
      positive(budget.requiredAmount);

    const planned =
      positive(budget.plannedAmount);

    const remainingRequired =
      Math.max(0, required - actual);

    const remainingPlanned =
      Math.max(0, planned - actual);

    return {

      category,

      nature: budget.nature || 'unspecified',

      actual,

      required,

      planned,

      remainingRequired,

      remainingPlanned,

      aboveRequired:
        required > 0 && actual > required,

      abovePlanned:
        planned > 0 && actual > planned,

      requiredMet:
        required > 0 && actual >= required,

      plannedMet:
        planned > 0 && actual >= planned

    };

  });


  const totalRequired = categories.reduce(
    (sum, category) =>
      sum + category.required,
    0
  );

  const totalPlanned = categories.reduce(
    (sum, category) =>
      sum + category.planned,
    0
  );

  // Do not subtract EMI/loan categories twice.
  const remainingRequired = categories.reduce(
    (sum, category) => {

      if (
        /emi|loan|instal+ment|installment/i
          .test(category.category)
      ) {
        return sum;
      }

      return sum + category.remainingRequired;

    },
    0
  );


  // ----------------------------------------------
  // LOAN CALCULATIONS
  // ----------------------------------------------

  const debts = getLatestLoans(
    portfolio.debtRecords
  );

  const activeLoans = debts.filter(
    loan => positive(loan.balance) > 0
  );

  const totalDebt = activeLoans.reduce(
    (sum, loan) =>
      sum + positive(loan.balance),
    0
  );

  const monthlyEmi = activeLoans.reduce(
    (sum, loan) =>
      sum + positive(loan.emi),
    0
  );

  // Identify EMIs already recorded as actual expenses
  // in the current month.

  const recordedEmi = monthRows
    .filter(isExpense)
    .filter(record => {

      const description = [
        record.category,
        record.subcategory,
        record.note,
        record.description
      ].filter(Boolean).join(' ');

      return /emi|loan|instal+ment|installment/i
        .test(description);

    })
    .reduce((sum, record) =>
      sum + txAmount(record), 0);

  const unpaidEmiEstimate = Math.max(
    0,
    monthlyEmi - recordedEmi
  );


  // ----------------------------------------------
  // PROTECTED RESERVE
  // ----------------------------------------------

  // This value must be saved to the user's
  // email preferences document by the app.
  // Until configured, the default is zero.

  const protectedReserve = positive(
    preferences.protectedReserve
  );


  // ----------------------------------------------
  // SAFE TO SPEND
  // Mirrors FinTrack Money Plan formula.
  // ----------------------------------------------

  const safeToSpend =
    availableCash -
    remainingRequired -
    unpaidEmiEstimate -
    protectedReserve;


  // ----------------------------------------------
  // BUDGET ALERTS
  // ----------------------------------------------

  const alerts = [];

  if (safeToSpend < 0) {

    alerts.push({

      level: 'CRITICAL',

      title: 'Projected cash shortfall',

      message:
        `Your estimated safe-to-spend is negative by ${INR(Math.abs(safeToSpend))}. Review flexible spending and upcoming commitments.`

    });

  }

  if (income > 0 && spent > income) {

    alerts.push({

      level: 'CAUTION',

      title: 'Expenses exceed income',

      message:
        `Recorded expenses exceed recorded income by ${INR(spent - income)} this month.`

    });

  }

  categories
    .filter(category => category.aboveRequired)
    .forEach(category => {

      alerts.push({

        level: 'CRITICAL',

        title: `${category.category} exceeded required budget`,

        message:
          `Actual spending is ${INR(category.actual)} against required ${INR(category.required)}.`

      });

    });

  categories
    .filter(category =>
      category.abovePlanned &&
      !category.aboveRequired
    )
    .forEach(category => {

      alerts.push({

        level: 'CAUTION',

        title: `${category.category} exceeded planned budget`,

        message:
          `You are ${INR(category.actual - category.planned)} above the planned amount, but still within the required amount.`

      });

    });


  if (!alerts.length) {

    alerts.push({

      level: 'HEALTHY',

      title: 'No major financial alerts',

      message:
        'No negative safe-to-spend balance or budget overruns were detected from the available records.'

    });

  }


  // ----------------------------------------------
  // PRACTICAL DAILY ACTION
  // ----------------------------------------------

  let recommendation = '';

  if (safeToSpend < 0) {

    recommendation =
      'Avoid discretionary purchases until essential commitments and cash availability have been reviewed.';

  } else if (
    categories.some(category => category.abovePlanned)
  ) {

    recommendation =
      'Review categories exceeding planned amounts. Pause non-essential purchases in those categories.';

  } else if (
    remainingRequired > 0
  ) {

    recommendation =
      `Keep ${INR(remainingRequired)} available for remaining required budget commitments.`;

  } else {

    recommendation =
      'Continue tracking expenses and protect your planned cash reserve.';

  }


  // ----------------------------------------------
  // UPCOMING RECURRING COMMITMENTS
  // ----------------------------------------------

  const recurring =
    safeArray(portfolio.fintrackRecurring);

  const today = period.key;

  const upcoming = recurring
    .filter(item =>
      item.nextDate &&
      String(item.nextDate).slice(0, 10) >= today
    )
    .sort((a, b) =>
      String(a.nextDate).localeCompare(
        String(b.nextDate)
      )
    )
    .slice(0, 8)
    .map(item => ({

      name: item.name || 'Scheduled item',

      type: item.type || 'Expense',

      amount: positive(item.amount),

      date: String(item.nextDate).slice(0, 10),

      frequency: item.frequency || 'Not specified'

    }));


  return {

    date: period.key,

    month: period.monthKey,

    income,

    spent,

    netCashFlow,

    availableCash,

    accountBalances,

    totalRequired,

    totalPlanned,

    remainingRequired,

    unpaidEmiEstimate,

    protectedReserve,

    safeToSpend,

    monthlyEmi,

    totalDebt,

    activeLoanCount: activeLoans.length,

    categories,

    alerts,

    recommendation,

    upcoming

  };

}


// --------------------------------------------------
// EMAIL HTML
// --------------------------------------------------

function buildEmail(summary) {

  const categoryRows = summary.categories.length

    ? summary.categories.map(category => `

      <tr>
        <td style="padding:10px;border-bottom:1px solid #eee">
          ${escapeHtml(category.category)}
        </td>

        <td style="padding:10px;text-align:right">
          ${INR(category.actual)}
        </td>

        <td style="padding:10px;text-align:right">
          ${INR(category.required)}
        </td>

        <td style="padding:10px;text-align:right">
          ${INR(category.planned)}
        </td>

        <td style="padding:10px;text-align:right">
          ${INR(category.remainingRequired)}
        </td>
      </tr>

    `).join('')

    : `
      <tr>
        <td colspan="5" style="padding:12px">
          No monthly budgets configured.
        </td>
      </tr>
    `;


  const alertRows = summary.alerts.map(alert => {

    const color =
      alert.level === 'CRITICAL' ? '#dc2626' :
      alert.level === 'CAUTION' ? '#d97706' :
      alert.level === 'HEALTHY' ? '#059669' :
      '#64748b';

    return `

      <div style="
        padding:12px;
        margin:10px 0;
        background:#f8fafc;
        border-left:4px solid ${color};
        border-radius:8px;
      ">

        <b style="color:${color}">
          ${escapeHtml(alert.level)}:
          ${escapeHtml(alert.title)}
        </b>

        <p style="margin:6px 0 0">
          ${escapeHtml(alert.message)}
        </p>

      </div>

    `;

  }).join('');


  const upcomingRows = summary.upcoming.length

    ? summary.upcoming.map(item => `

      <tr>

        <td style="padding:9px">
          ${escapeHtml(item.name)}
        </td>

        <td style="padding:9px">
          ${escapeHtml(item.date)}
        </td>

        <td style="padding:9px;text-align:right">
          ${INR(item.amount)}
        </td>

      </tr>

    `).join('')

    : `
      <tr>
        <td colspan="3" style="padding:10px">
          No upcoming recurring commitments recorded.
        </td>
      </tr>
    `;


  const accountRows = Object.entries(
    summary.accountBalances
  ).map(([name, balance]) => `

    <tr>

      <td style="padding:8px">
        ${escapeHtml(name)}
      </td>

      <td style="padding:8px;text-align:right">
        ${INR(balance)}
      </td>

    </tr>

  `).join('');


  return `

  <!doctype html>

  <html>

  <body style="
    margin:0;
    background:#f1f5f9;
    font-family:Arial,sans-serif;
    color:#172033;
  ">

    <div style="
      max-width:720px;
      margin:20px auto;
      background:white;
      border-radius:16px;
      overflow:hidden;
    ">

      <div style="
        padding:26px;
        background:#111827;
        color:white;
      ">

        <div style="
          color:#a5b4fc;
          font-size:12px;
          font-weight:bold;
        ">
          FINTRACK · DAILY FINANCIAL BRIEF
        </div>

        <h1 style="margin:10px 0">
          Your Financial Health Report
        </h1>

        <p style="color:#cbd5e1">
          ${escapeHtml(summary.date)}
          · 08:00 AM IST
        </p>

      </div>


      <div style="padding:22px">


        <h2>1. Your cash position</h2>

        <table width="100%" cellpadding="0" cellspacing="8">

          <tr>

            <td style="
              padding:14px;
              background:#f8fafc;
              border-radius:10px;
            ">

              <small>Available cash</small>

              <h2>${INR(summary.availableCash)}</h2>

            </td>

            <td style="
              padding:14px;
              background:#f8fafc;
              border-radius:10px;
            ">

              <small>Safe to spend</small>

              <h2 style="
                color:${summary.safeToSpend < 0
                  ? '#dc2626'
                  : '#059669'};
              ">
                ${INR(summary.safeToSpend)}
              </h2>

            </td>

          </tr>

          <tr>

            <td style="
              padding:14px;
              background:#f8fafc;
              border-radius:10px;
            ">

              <small>Monthly income</small>

              <h2>${INR(summary.income)}</h2>

            </td>

            <td style="
              padding:14px;
              background:#f8fafc;
              border-radius:10px;
            ">

              <small>Monthly expenses</small>

              <h2>${INR(summary.spent)}</h2>

            </td>

          </tr>

        </table>


        <p>
          Net cash flow:
          <b style="
            color:${summary.netCashFlow >= 0
              ? '#059669'
              : '#dc2626'};
          ">
            ${INR(summary.netCashFlow)}
          </b>
        </p>


        <h2>2. Budget health</h2>

        <p>
          Required budget:
          <b>${INR(summary.totalRequired)}</b>
          <br>

          Planned budget:
          <b>${INR(summary.totalPlanned)}</b>
          <br>

          Required budget still due:
          <b>${INR(summary.remainingRequired)}</b>
        </p>


        <div style="overflow-x:auto">

          <table style="
            width:100%;
            border-collapse:collapse;
            font-size:12px;
          ">

            <thead style="background:#f1f5f9">

              <tr>

                <th style="padding:10px;text-align:left">
                  Category
                </th>

                <th style="padding:10px">
                  Actual
                </th>

                <th style="padding:10px">
                  Required
                </th>

                <th style="padding:10px">
                  Planned
                </th>

                <th style="padding:10px">
                  Required left
                </th>

              </tr>

            </thead>

            <tbody>
              ${categoryRows}
            </tbody>

          </table>

        </div>


        <h2>3. Financial alerts</h2>

        ${alertRows}


        <h2>4. Loan and EMI commitments</h2>

        <p>
          Outstanding loans:
          <b>${INR(summary.totalDebt)}</b>
          <br>

          Monthly EMI:
          <b>${INR(summary.monthlyEmi)}</b>
          <br>

          Estimated unpaid EMI:
          <b>${INR(summary.unpaidEmiEstimate)}</b>
        </p>


        <h2>5. Upcoming commitments</h2>

        <table style="
          width:100%;
          border-collapse:collapse;
          font-size:13px;
        ">

          <thead style="background:#f1f5f9">

            <tr>
              <th style="padding:9px;text-align:left">Item</th>
              <th style="padding:9px">Due date</th>
              <th style="padding:9px">Amount</th>
            </tr>

          </thead>

          <tbody>
            ${upcomingRows}
          </tbody>

        </table>


        <h2>6. Account balances</h2>

        <table style="
          width:100%;
          border-collapse:collapse;
        ">

          ${accountRows}

        </table>


        <h2>7. FinTrack recommendation</h2>

        <div style="
          padding:16px;
          background:#eef2ff;
          border-radius:12px;
        ">

          ${escapeHtml(summary.recommendation)}

        </div>


        <h2>8. Protected cash reserve</h2>

        <p>
          ${INR(summary.protectedReserve)}
        </p>

        <p style="
          font-size:11px;
          color:#64748b;
          border-top:1px solid #e5e7eb;
          padding-top:14px;
        ">

          Generated from your latest synced FinTrack portfolio.
          Safe-to-spend is an estimate based on recorded account
          balances, remaining required budgets, unpaid EMI
          estimate and protected reserve.

          Verify upcoming payments and actual bank balances
          before making financial decisions.

        </p>

      </div>

    </div>

  </body>

  </html>

  `;

}


// --------------------------------------------------
// SCHEDULED EMAIL FUNCTION
// --------------------------------------------------

exports.sendDailyFinancialEmail = onSchedule({

  schedule: '0 8 * * *',

  timeZone: TIME_ZONE,

  region: 'asia-south1',

  secrets: [RESEND_API_KEY],

  retryCount: 2,

  maxInstances: 1

}, async () => {

  const resend = new Resend(
    RESEND_API_KEY.value()
  );

  const today = localDateParts().key;

  const users = await db
    .collection('users')
    .get();


  for (const userDoc of users.docs) {

    const uid = userDoc.id;

    const preferenceRef = db.doc(
      `users/${uid}/settings/dailyFinancialEmail`
    );

    try {

      const [
        preferenceSnap,
        portfolioSnap,
        authUser
      ] = await Promise.all([

        preferenceRef.get(),

        db.doc(
          `users/${uid}/portfolio/main`
        ).get(),

        admin.auth().getUser(uid)

      ]);


      const preferences =
        preferenceSnap.data() || {};


      // ------------------------------------------
      // USER OPT-IN CHECK
      // ------------------------------------------

      if (
        preferences.enabled !== true ||
        preferences.timezone !== TIME_ZONE ||
        Number(preferences.sendHour) !== 8 ||
        Number(preferences.sendMinute) !== 0
      ) {
        continue;
      }


      // ------------------------------------------
      // AUTHENTICATED EMAIL CHECK
      // ------------------------------------------

      if (
        !authUser.email ||
        authUser.emailVerified !== true
      ) {

        logger.warn(
          'Daily email skipped: account email is not verified',
          { uid }
        );

        continue;

      }


      // ------------------------------------------
      // DUPLICATE EMAIL PREVENTION
      // ------------------------------------------

      if (
        String(preferences.lastSentDate || '') === today
      ) {
        continue;
      }


      if (!portfolioSnap.exists) {

        logger.warn(
          'Portfolio document not found',
          { uid }
        );

        continue;

      }


      // ------------------------------------------
      // GENERATE FINANCIAL REPORT
      // ------------------------------------------

      const portfolio = portfolioSnap.data();

      const summary = calculateFinancialHealth(
        portfolio,
        preferences
      );


      // ------------------------------------------
      // SEND EMAIL
      // ------------------------------------------

      const result = await resend.emails.send({

        from: FROM_EMAIL,

        to: [authUser.email],

        subject:
          `FinTrack Daily Financial Health · ${today}`,

        html: buildEmail(summary)

      });


      if (result.error) {

        throw new Error(
          result.error.message ||
          'Resend email delivery failed'
        );

      }


      // ------------------------------------------
      // RECORD SUCCESSFUL DELIVERY
      // ------------------------------------------

      await preferenceRef.set({

        lastSentDate: today,

        lastSentAt:
          admin.firestore.FieldValue.serverTimestamp(),

        lastDeliveryStatus: 'sent',

        lastEmailId:
          result.data?.id || null

      }, {

        merge: true

      });


      logger.info(
        'FinTrack daily financial email sent',
        {
          uid,
          email: authUser.email,
          date: today
        }
      );


    } catch (error) {

      logger.error(
        'FinTrack daily email failed',
        {
          uid,
          error: error.message
        }
      );


      await preferenceRef.set({

        lastDeliveryStatus: 'failed',

        lastFailureAt:
          admin.firestore.FieldValue.serverTimestamp(),

        lastFailureMessage:
          String(error.message).slice(0, 240)

      }, {

        merge: true

      }).catch(() => {});

    }

  }

});
