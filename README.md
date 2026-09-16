# 🖥️ ScreenShare — salas com código para compartilhar tela

Site simples para **criar uma sala, compartilhar a tela (vídeo + áudio da tela, sem voz)** e convidar pelo **código**. Todo mundo na sala pode compartilhar. Tem **chat de texto** junto.

Stack: `Node.js + Express + WebSocket (ws)` servindo frontend estático + sinalização **WebRTC P2P (mesh)**. Sem banco, sem login.

---

## ✨ Como funciona

1. Alguém entra, digita o nome e clica **Criar sala** → ganha código de 6 caracteres (ex: `X7K2PQ`) + link `/sala.html?codigo=X7K2PQ`.
2. Na sala, clica **Compartilhar tela**, escolhe aba/janela/tela inteira e marca **“Compartilhar áudio”** para sair som.
3. Manda o **código ou link** para outra pessoa → ela entra com o código e **assiste na hora**.
4. Qualquer participante pode compartilhar também. Microfone **nunca** é capturado — só `getDisplayMedia` (tela + áudio do sistema).

> Limite prático: mesh P2P funciona liso com 2–6 pessoas compartilhando/assistindo. Com 20 espectadores e 1 compartilhando, funciona bem na maioria das redes. "Ilimitado" no sentido de sem trava no código — o gargalo é upload de quem compartilha.

---

## ▶️ Rodar local

```bash
cd screenshare
npm install
npm start
# abre http://localhost:3000
```

Teste rápido: abra `http://localhost:3000`, crie uma sala, depois abra o link da sala em **outra aba anônima** e entre com outro nome. Compartilhe a tela em uma e assista na outra.

---

## 🐳 Docker (local)

```bash
docker build -t screenshare .
docker run -p 3000:3000 screenshare
# ou
docker compose up --build
```

---

## 🚀 Subir na VPS com Coolify

1. **Suba no GitHub:**
   ```bash
   cd screenshare
   git init
   git add .
   git commit -m "screenshare inicial"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/screenshare.git
   git push -u origin main
   ```

2. **No Coolify:**
   - `Projects → New → Application → Public/Private Repository` → selecione o repo `screenshare`.
   - **Build Pack:** `Dockerfile` (ele detecta sozinho o `Dockerfile` da raiz).
   - **Port:** `3000`.
   - **Domain:** coloque seu domínio, ex: `share.seudominio.com`.
   - **HTTPS:** deixe o Coolify gerar (Let's Encrypt) **ou** use Cloudflare (abaixo).
   - Deploy. Healthcheck: `/api/health`.

3. **Variáveis de ambiente (opcional):**
   | Var | Padrão | Para que |
   |---|---|---|
   | `PORT` | `3000` | porta interna (Coolify injeta sozinho) |
   | `STUN_URL` | `stun:stun.l.google.com:19302` | servidor STUN |
   | `TURN_URL` | vazio | ex: `turn:turn.seudominio.com:3478` (recomendado p/ 4G/CGNAT) |
   | `TURN_USERNAME` / `TURN_PASSWORD` | vazio | credencial do TURN |

> Sem TURN funciona em ~80–90% das redes. Se algum usuário atrás de CGNAT/4G não conectar vídeo, suba um **coturn** na VPS e preencha as 3 vars acima.

---

## ☁️ Cloudflare (domínio + HTTPS)

`getDisplayMedia` (compartilhar tela) **exige HTTPS** (exceto localhost). Por isso:

1. No Cloudflare → `DNS` → crie `A` apontando `share.seudominio.com` → IP da VPS (proxy 🟧 ativado).
2. `SSL/TLS → Overview → Full (strict)`.
3. No Coolify, coloque o mesmo domínio no app.
4. `Rules → ...` nada especial: **WebSocket precisa ficar ativo** — com proxy 🟧 o Cloudflare já passa WS/WSS. Não ative "Rocket Loader" agressivo nem cache em `/ws` e `/api/*`.
5. Teste: `https://share.seudominio.com` → cadeado → criar sala → compartilhar.

Link curto de convite também funciona: `https://share.seudominio.com/s/ABC123` redireciona para a sala.

---

## 🧩 Protocolo WS (`/ws`)

- `join {code, name, id}` → `joined {id, code, peers[], count}` + `peer-joined` p/ outros
- `offer/answer {to, sdp}` , `ice {to, candidate}` (relay 1:1)
- `share-state {sharing}` → broadcast (para mostrar "compartilhando")
- `chat {text}` → broadcast `{from, name, text, ts}`
- `ping` → `pong`

Salas ficam **em memória** (reiniciou o container, limpou). Sem persistência proposital.

---

## 📁 Estrutura

```
screenshare/
├── server.js           # Express + WS signaling + salas em memória
├── package.json
├── Dockerfile
├── docker-compose.yml
└── public/
    ├── index.html      # landing: criar / entrar
    ├── sala.html       # sala: vídeos + chat + participantes
    ├── styles.css
    └── room.js         # WebRTC mesh + WS + chat
```

## 🔒 Privacidade

- Nada é gravado. Vídeo vai **direto entre navegadores** (P2P). O servidor só troca "sinalização" (offer/answer/ICE) e chat.
- Nenhum microfone/câmera é acessado. Só tela.

## 🛠️ Próximos passos sugeridos (se quiser depois)

- [ ] TURN próprio (coturn) na mesma VPS
- [ ] Nome/avatar colorido por usuário
- [ ] Expulsar / sala com senha
- [ ] Contador de tempo da sala
