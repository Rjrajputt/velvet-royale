const state = {
  user: null,
  activeTeenPattiRound: null,
};

async function api(pathname, options = {}) {
  const response = await fetch(pathname, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || 'Request failed.');
  }

  return payload;
}

function setStatus(el, html) {
  el.innerHTML = html;
}

function formatCard(card) {
  const red = ['♥', '♦'].includes(card.suit);
  return `
    <div class="card ${red ? 'red' : ''}">
      <span>${card.label}</span>
    </div>
  `;
}

function renderCards(cards) {
  return `
    <div class="card-row">
      ${cards.map(formatCard).join('')}
    </div>
  `;
}

function renderUser() {
  const username = state.user?.username || 'Guest';
  const balance = state.user?.vc_balance ?? 0;

  document.getElementById('userLabel').textContent = state.user?.username ? 'Player' : 'Guest';
  document.getElementById('userName').textContent = username;
  document.getElementById('vcBalance').textContent = balance;
}

async function loadLeaderboard() {
  try {
    const data = await api('/api/leaderboard');
    const list = document.getElementById('leaderboardList');

    if (!data.leaderboard || data.leaderboard.length === 0) {
      list.innerHTML = '<div class="leader-item"><span>No data yet</span><strong>0 VC</strong></div>';
      return;
    }

    list.innerHTML = data.leaderboard
      .map(
        (entry, index) => `
          <div class="leader-item">
            <span>#${index + 1} ${entry.username}</span>
            <strong>${entry.vc_balance} VC</strong>
          </div>
        `
      )
      .join('');
  } catch (error) {
    console.error(error);
  }
}

async function boot() {
  try {
    const data = await api('/api/boot');
    state.user = data.user;
    renderUser();
    await loadLeaderboard();
  } catch (error) {
    console.error(error);
  }
}

async function claimDailyBonus() {
  try {
    const data = await api('/api/claim-daily-bonus', { method: 'POST' });
    state.user = data.user;
    renderUser();
    setStatus(document.getElementById('teenPattiState'), `<strong>Daily bonus:</strong> +${data.amount} VC`);
    await loadLeaderboard();
  } catch (error) {
    setStatus(document.getElementById('teenPattiState'), `<strong>Bonus blocked:</strong> ${error.message}`);
  }
}

async function buyStarterPack() {
  try {
    const data = await api('/api/mock-buy-vc', {
      method: 'POST',
      body: JSON.stringify({ pack: 'starter' }),
    });

    state.user = data.user;
    renderUser();
    setStatus(document.getElementById('raffleState'), `<strong>Demo buy:</strong> +${data.amount} VC. No real money moved.`);
    await loadLeaderboard();
  } catch (error) {
    setStatus(document.getElementById('raffleState'), `<strong>Purchase failed:</strong> ${error.message}`);
  }
}

async function startTeenPattiRound() {
  try {
    const result = await api('/api/game/teen-patti/start', {
      method: 'POST',
      body: JSON.stringify({ bet: 25 }),
    });

    state.activeTeenPattiRound = result;
    const playerHtml = renderCards(result.playerCards);
    const dealerHtml = renderCards(result.dealerCards);

    const teenState = document.getElementById('teenPattiState');
    setStatus(
      teenState,
      `
        <div class="summary">
          <span>Round ID: <strong>${result.roundId}</strong></span>
          <span>Bet: <strong>${result.bet} VC</strong></span>
        </div>
        <div>
          <div class="card-label">Your hand</div>
          ${playerHtml}
        </div>
        <div>
          <div class="card-label">Dealer hand</div>
          ${dealerHtml}
        </div>
      `
    );

    const actions = document.getElementById('teenPattiActions');
    actions.classList.remove('hidden');
    actions.innerHTML = `
      <button id="resolveTeenPattiBtn" class="primary action">Resolve Showdown</button>
    `;

    document.getElementById('resolveTeenPattiBtn').addEventListener('click', resolveTeenPattiRound);
  } catch (error) {
    setStatus(document.getElementById('teenPattiState'), `<strong>Round unavailable:</strong> ${error.message}`);
  }
}

async function resolveTeenPattiRound() {
  try {
    const roundId = state.activeTeenPattiRound?.roundId;
    if (!roundId) {
      throw new Error('No active Teen Patti round.');
    }

    const result = await api('/api/game/teen-patti/resolve', {
      method: 'POST',
      body: JSON.stringify({ roundId }),
    });

    state.user = result.user;
    renderUser();

    const outcomeText = result.outcome === 'win' ? 'Victory' : 'Defeat';
    const teenState = document.getElementById('teenPattiState');
    setStatus(
      teenState,
      `
        <div class="summary">
          <span>Outcome: <strong>${outcomeText}</strong></span>
          <span>Reward: <strong>${result.payout} VC</strong></span>
        </div>
        <div>
          <div class="card-label">Your hand</div>
          ${renderCards(result.playerCards)}
        </div>
        <div>
          <div class="card-label">Dealer hand</div>
          ${renderCards(result.dealerCards)}
        </div>
      `
    );

    document.getElementById('teenPattiActions').classList.add('hidden');
    await loadLeaderboard();
  } catch (error) {
    setStatus(document.getElementById('teenPattiState'), `<strong>Resolve failed:</strong> ${error.message}`);
  }
}

async function drawRaffle() {
  try {
    const data = await api('/api/game/raffle/draw', {
      method: 'POST',
      body: JSON.stringify({ ticketCount: 1 }),
    });

    state.user = data.user;
    renderUser();

    const raffleState = document.getElementById('raffleState');
    setStatus(
      raffleState,
      `
        <div class="summary">
          <span>Ticket: <strong>${data.ticket.join(', ')}</strong></span>
          <span>Matches: <strong>${data.matches}</strong></span>
        </div>
        <div class="summary">
          <span>Winning numbers: <strong>${data.winningNumbers.join(', ')}</strong></span>
          <span>Win: <strong>${data.winAmount} VC</strong></span>
        </div>
      `
    );

    await loadLeaderboard();
  } catch (error) {
    setStatus(document.getElementById('raffleState'), `<strong>Raffle failed:</strong> ${error.message}`);
  }
}

document.getElementById('dailyBonusBtn').addEventListener('click', claimDailyBonus);
document.getElementById('buyStarterPackBtn').addEventListener('click', buyStarterPack);
document.getElementById('startTeenPattiBtn').addEventListener('click', startTeenPattiRound);
document.getElementById('drawRaffleBtn').addEventListener('click', drawRaffle);

boot();
