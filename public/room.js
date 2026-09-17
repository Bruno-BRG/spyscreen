(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const code = (params.get('codigo') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  let myName = (params.get('nome') || '').trim().slice(0, 30);

  if (!myName) {
    try { myName = localStorage.getItem('ss_name') || ''; } catch {}
  }
  if (!myName) {
    myName = prompt('Seu nome para entrar na sala:') || 'Convidado';
    myName = String(myName).trim().slice(0, 30) || 'Convidado';
  }
  try { localStorage.setItem('ss_name', myName); } catch {}

  if (!code || code.length < 4) {
    alert('Código de sala inválido.');
    location.href = '/';
    return;
  }

  const localId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const videosEl = $('videos');
  const emptyState = $('emptyState');
  const participantsEl = $('participants');
  const messagesEl = $('messages');
  const statusEl = $('status');
  const countPill = $('countPill');

  $('roomCode').textContent = code;
  $('roomSubtitle').textContent = `sala ${code} • ${myName}`;

  const peers = new Map(); // peerId -> { name, pc, makingOffer, polite, stream, videoEl, sharing }
  const names = new Map(); // peerId -> name (inclui eu)
  names.set(localId, myName + ' (você)');

  let ws = null;
  let wsRetries = 0;
  let connectSeq = 0;
  const outbox = []; // mensagens digitadas sem conexão: enviadas ao entrar
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let localScreenStream = null;
  let sharing = false;

  function setShareUI(on) {
    sharing = on;
    const btn = $('btnShare');
    btn.textContent = on ? '⏹ Parar de compartilhar' : '🖥️ Compartilhar tela';
    btn.className = on ? 'btn danger' : 'btn';
    btn.style.width = 'auto';
  }

  const toast = (msg) => {
    let t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.style.display = 'none'), 2600);
  };

  function setStatus(text, online) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (online ? ' online' : '');
  }

  // ---------- ICE config ----------
  fetch('/api/config').then((r) => r.json()).then((j) => {
    if (j && Array.isArray(j.iceServers) && j.iceServers.length) iceServers = j.iceServers;
  }).catch(() => {});

  // ---------- UI: vídeos ----------
  function refreshEmpty() {
    const hasVideo = videosEl.querySelector('.video-card');
    emptyState.style.display = hasVideo ? 'none' : 'block';
  }

  function tryPlay(video, overlay) {
    // Navegadores bloqueiam autoplay COM som: começamos mutado e o usuário ativa o som com 1 clique.
    const p = video.play();
    if (p && p.catch) p.catch(() => {});
  }

  function ensureVideoCard(peerId, displayName, isLocal) {
    let card = videosEl.querySelector(`[data-peer="${peerId}"]`);
    if (card) return card;
    emptyState.style.display = 'none';

    card = document.createElement('div');
    card.className = 'video-card';
    card.dataset.peer = peerId;

    const wrap = document.createElement('div');
    wrap.className = 'video-wrap';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.controls = false;
    video.muted = true; // sempre começa mutado (autoplay liberado); som sai no overlay abaixo
    video.preload = 'auto';

    const overlay = document.createElement('button');
    overlay.className = 'sound-overlay';
    overlay.style.display = isLocal ? 'none' : 'flex';
    overlay.innerHTML = '<span>🔊 Clique para ativar o som</span>';
    overlay.title = 'Ativar som';
    overlay.onclick = (ev) => {
      ev.stopPropagation();
      video.muted = false;
      tryPlay(video, overlay);
      overlay.style.display = 'none';
    };

    video.addEventListener('playing', () => {
      // se está tocando COM som, esconde o overlay; se mutado e é remoto, mostra
      if (!video.muted) overlay.style.display = 'none';
      else if (!isLocal) overlay.style.display = 'flex';
    });

    wrap.appendChild(video);
    wrap.appendChild(overlay);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.gap = '6px';
    left.style.alignItems = 'center';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = displayName;
    nameSpan.style.fontWeight = '700';

    const tag = document.createElement('span');
    tag.className = 'tag live';
    tag.textContent = '● ao vivo';

    const you = document.createElement('span');
    you.className = 'tag you';
    you.textContent = 'você';
    you.style.display = isLocal ? 'inline-block' : 'none';

    left.appendChild(nameSpan);
    left.appendChild(you);
    left.appendChild(tag);

    const actions = document.createElement('div');
    actions.className = 'video-actions';

    const btnFull = document.createElement('button');
    btnFull.className = 'mini-btn';
    btnFull.textContent = '⛶ tela cheia';
    btnFull.title = 'tela cheia';
    btnFull.onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (card.requestFullscreen) await card.requestFullscreen();
        else if (video.requestFullscreen) await video.requestFullscreen();
      } catch {}
    };

    actions.appendChild(btnFull);

    meta.appendChild(left);
    meta.appendChild(actions);
    card.appendChild(wrap);
    card.appendChild(meta);
    videosEl.appendChild(card);
    refreshEmpty();
    return card;
  }

  function removeVideoCard(peerId) {
    const card = videosEl.querySelector(`[data-peer="${peerId}"]`);
    if (card) card.remove();
    refreshEmpty();
  }

  function updateParticipants() {
    participantsEl.innerHTML = '';
    const entries = [...names.entries()];
    countPill.textContent = `👥 ${entries.length} na sala`;
    for (const [id, n] of entries) {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = (id === localId ? '🟢 ' : '⚪ ') + n;
      const right = document.createElement('span');
      right.className = 'tag' + (peers.get(id)?.sharing || id === localId && localScreenStream ? ' live' : '');
      right.textContent = (peers.get(id)?.sharing || (id === localId && localScreenStream)) ? 'compartilhando' : 'assistindo';
      li.appendChild(left);
      li.appendChild(right);
      participantsEl.appendChild(li);
    }
  }

  function addChat(fromName, text, ts, mine) {
    const div = document.createElement('div');
    div.className = 'msg' + (mine ? ' mine' : '');
    const b = document.createElement('b');
    const time = new Date(ts || Date.now());
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    b.innerHTML = '';
    b.textContent = fromName;
    const t = document.createElement('time');
    t.textContent = `${hh}:${mm}`;
    b.appendChild(t);
    const p = document.createElement('div');
    p.textContent = text;
    div.appendChild(b);
    div.appendChild(p);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); return true; } catch { /* cai no false */ }
    }
    return false;
  }

  // ---------- WebRTC ----------
  function createPeerConnection(peerId, peerName) {
    if (peers.has(peerId)) return peers.get(peerId);

    const polite = localId < peerId; // id menor é "polite" (resolve glare)
    const pc = new RTCPeerConnection({ iceServers });
    const state = { name: peerName, pc, makingOffer: false, ignoreOffer: false, polite, stream: null, sharing: false };

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'ice', to: peerId, candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      const incoming = (e.streams && e.streams[0]) || null;
      state.stream = incoming || state.stream || new MediaStream();
      if (!incoming && e.track && !state.stream.getTrackById(e.track.id)) {
        try { state.stream.addTrack(e.track); } catch {}
      }
      state.sharing = true;
      const card = ensureVideoCard(peerId, peerName, false);
      const video = card.querySelector('video');
      const overlay = card.querySelector('.sound-overlay');
      if (video.srcObject !== state.stream) video.srcObject = state.stream;
      video.muted = true; // garante autoplay; usuário ativa o som no overlay
      if (overlay) overlay.style.display = 'flex';
      tryPlay(video, overlay);
      // se quem compartilha parar, some o card sozinho
      try {
        state.stream.onremovetrack = () => {
          const vids = state.stream.getVideoTracks();
          if (vids.length === 0) {
            state.sharing = false;
            removeVideoCard(peerId);
            updateParticipants();
          }
        };
      } catch {}
      updateParticipants();
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        // mantém card por 2s caso volte; se fechou mesmo, peer-left vai limpar
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        await pc.setLocalDescription(await pc.createOffer());
        send({ type: 'offer', to: peerId, sdp: pc.localDescription });
      } catch (err) {
        console.warn('negotiationneeded falhou', err);
      } finally {
        state.makingOffer = false;
      }
    };

    // se eu já estou compartilhando, adiciona minhas tracks nesse PC novo
    if (localScreenStream) {
      localScreenStream.getTracks().forEach((t) => pc.addTrack(t, localScreenStream));
    }

    peers.set(peerId, state);
    return state;
  }

  async function handleOffer(from, sdp) {
    const st = peers.get(from) || createPeerConnection(from, names.get(from) || 'Participante');
    const pc = st.pc;
    const collision = st.makingOffer || pc.signalingState !== 'stable';
    st.ignoreOffer = !st.polite && collision;
    if (st.ignoreOffer) return; // ignora (o outro lado vai resolver)

    try {
      if (collision && pc.signalingState !== 'stable') {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(sdp),
        ]);
      } else {
        await pc.setRemoteDescription(sdp);
      }
      await pc.setLocalDescription(await pc.createAnswer());
      send({ type: 'answer', to: from, sdp: pc.localDescription });
    } catch (err) {
      console.warn('handleOffer falhou', err);
    }
  }

  async function handleAnswer(from, sdp) {
    const st = peers.get(from);
    if (!st) return;
    try {
      await st.pc.setRemoteDescription(sdp);
    } catch (err) {
      console.warn('handleAnswer falhou', err);
    }
  }

  async function handleIce(from, candidate) {
    const st = peers.get(from);
    if (!st || !candidate) return;
    try {
      await st.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('addIceCandidate falhou', err);
    }
  }

  // ---------- WebSocket ----------
  function connect() {
    const mySeq = ++connectSeq;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws');

    ws.onopen = () => {
      wsRetries = 0;
      setStatus('conectado • entrando na sala…', true);
      send({ type: 'join', code, name: myName, id: localId });
    };

    ws.onmessage = async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'joined') {
        setStatus(`na sala ${msg.code} • ${msg.count} pessoa(s)`, true);
        while (outbox.length) { const m = outbox.shift(); send(m); }
        (msg.peers || []).forEach((p) => {
          names.set(p.id, p.name);
          const st = createPeerConnection(p.id, p.name);
          // eu sou o novo: eu inicio a oferta para cada existente
          (async () => {
            try {
              st.makingOffer = true;
              await st.pc.setLocalDescription(await st.pc.createOffer());
              send({ type: 'offer', to: p.id, sdp: st.pc.localDescription });
            } catch (err) { console.warn('offer inicial falhou', err); }
            finally { st.makingOffer = false; }
          })();
        });
        updateParticipants();
      }
      else if (msg.type === 'peer-joined') {
        names.set(msg.id, msg.name);
        createPeerConnection(msg.id, msg.name); // espero a oferta dele
        updateParticipants();
        addChat('—', `${msg.name} entrou na sala`, Date.now(), false);
      }
      else if (msg.type === 'peer-left') {
        const st = peers.get(msg.id);
        if (st) { try { st.pc.close(); } catch {} peers.delete(msg.id); }
        names.delete(msg.id);
        removeVideoCard(msg.id);
        updateParticipants();
      }
      else if (msg.type === 'room-info') {
        setStatus(`na sala ${code} • ${msg.count} pessoa(s)`, true);
      }
      else if (msg.type === 'offer') handleOffer(msg.from, msg.sdp);
      else if (msg.type === 'answer') handleAnswer(msg.from, msg.sdp);
      else if (msg.type === 'ice') handleIce(msg.from, msg.candidate);
      else if (msg.type === 'share-state') {
        const st = peers.get(msg.from);
        if (st) {
          st.sharing = !!msg.sharing;
          if (!msg.sharing) removeVideoCard(msg.from);
          updateParticipants();
        }
      }
      else if (msg.type === 'chat') {
        addChat(msg.name, msg.text, msg.ts, msg.from === localId);
      }
      else if (msg.type === 'error') toast(msg.message || 'Erro');
    };

    ws.onclose = () => {
      if (mySeq !== connectSeq) return; // conexão velha: ignora
      setStatus('desconectado — tentando reconectar…', false);
      if (wsRetries < 8) {
        wsRetries++;
        setTimeout(connect, 1500 * wsRetries);
      } else {
        setStatus('desconectado — recarregue a página', false);
      }
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  // ---------- Compartilhar tela ----------
  async function startShare() {
    if (sharing) { stopShare(); return; }
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      toast('Compartilhar tela exige HTTPS. Acesse pelo domínio com cadeado.');
      return;
    }
    const btn = $('btnShare');
    btn.disabled = true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true, // áudio DO SISTEMA, se o usuário marcar "compartilhar áudio"
      });
      localScreenStream = stream;

      // preview local
      const card = ensureVideoCard(localId, myName, true);
      const video = card.querySelector('video');
      video.srcObject = stream;
      tryPlay(video, null);

      // envia tracks para todos os peers (renegocia)
      for (const [peerId, st] of peers.entries()) {
        try {
          stream.getTracks().forEach((t) => st.pc.addTrack(t, stream));
        } catch (err) { console.warn('addTrack falhou', peerId, err); }
      }
      send({ type: 'share-state', sharing: true });

      // se o usuário clicar em "interromper compartilhamento" no popup do navegador
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopShare());

      setShareUI(true);
      updateParticipants();
      toast('Compartilhando! Lembre: marque “compartilhar áudio” para sair som.');
    } catch (err) {
      if (err && err.name === 'NotAllowedError') toast('Você cancelou o compartilhamento.');
      else toast('Não foi possível compartilhar: ' + (err.message || err.name));
    } finally {
      btn.disabled = false;
    }
  }

  function stopShare() {
    if (!localScreenStream) return;
    try {
      // remove senders de todos os PCs
      for (const [, st] of peers.entries()) {
        try {
          const senders = st.pc.getSenders().filter((s) =>
            s.track && localScreenStream.getTrackById(s.track.id)
          );
          senders.forEach((s) => {
            try { st.pc.removeTrack(s); } catch {}
          });
        } catch {}
      }
      localScreenStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    } finally {
      localScreenStream = null;
      removeVideoCard(localId);
      send({ type: 'share-state', sharing: false });
      setShareUI(false);
      updateParticipants();
    }
  }

  // ---------- Chat ----------
  function sendChat() {
    const input = $('chatText');
    const text = input.value.trim();
    if (!text) return;
    if (send({ type: 'chat', text })) {
      input.value = '';
    } else {
      outbox.push({ type: 'chat', text });
      input.value = '';
      toast('Sem conexão — reconectando, sua mensagem vai sozinha.');
      if (!ws || ws.readyState === 3) connect();
    }
  }

  // ---------- Botões ----------
  $('btnShare').onclick = startShare;
  $('btnSend').onclick = sendChat;
  $('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  $('btnLeave').onclick = () => { try { ws && ws.close(); } catch {} location.href = '/'; };
  $('btnInvite').onclick = async () => {
    const link = `${location.origin}/sala.html?codigo=${encodeURIComponent(code)}`;
    const text = `Entra na minha sala ${code}: ${link}`;
    try { await navigator.clipboard.writeText(text); toast('Convite copiado! É só mandar.'); }
    catch { prompt('Copie o convite:', text); }
  };

  // primeiro clique na página tenta dar play com som nos vídeos que travaram no mudo
  document.addEventListener('click', () => {
    document.querySelectorAll('.video-card').forEach((card) => {
      if (card.dataset.peer === localId) return;
      const video = card.querySelector('video');
      const overlay = card.querySelector('.sound-overlay');
      if (video && !video.muted && video.paused) {
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      }
      void overlay;
    });
  });

  // heartbeat
  setInterval(() => send({ type: 'ping' }), 25000);

  updateParticipants();
  connect();
})();
