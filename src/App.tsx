import { useEffect, useRef, useState } from 'react';
import { Game, GameState } from './game/game';
import { Globe, Users, Shield, Server, ArrowLeft, Play, Wifi, Check, Crosshair, Copy, Link2 } from 'lucide-react';

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [gameState, setGameState] = useState<GameState>({
    hp: 100, maxHp: 100, equipment: 'rifle', inventory: 0,
    isDead: false, respawnTimer: 0, hitMarker: false, targetInfo: '',
    message: '', messageTimer: 0, buildMode: false, buildValid: true,
    blueKills: 0, redKills: 0, blueCaptures: 0, redCaptures: 0, isAiming: false,
    currentAmmo: 10, magazineSize: 10, isReloading: false,
    playerCarryingFlag: false, flagCarrierName: '',
    isSpectating: false,
    spectatorMode: 'action',
    spectatorTrackedName: '',
  });
  const [started, setStarted] = useState(false);
  const [gameMode, setGameMode] = useState<'multiplayer' | 'singleplayer' | 'online' | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<'red' | 'blue'>('blue');
  const [isPointerLocked, setIsPointerLocked] = useState(false);

  // Multiplayer Server & Team Selection state
  const isGitHubPages = typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');
  const [showMultiplayerModal, setShowMultiplayerModal] = useState(false);
  const [serverType, setServerType] = useState<'default' | 'custom'>(() => (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io') ? 'custom' : 'default'));
  const [customServerUrl, setCustomServerUrl] = useState('');
  const [playerName, setPlayerName] = useState(() => 'Soldier_' + Math.floor(100 + Math.random() * 900));
  const [modalTeam, setModalTeam] = useState<'blue' | 'red'>('blue');
  const [serverUrl, setServerUrl] = useState<string | undefined>(undefined);
  const [copiedInvite, setCopiedInvite] = useState(false);

  // Auto-launch support for automated previewing and AI testing via URL query parameters (?mode=spectator, ?mode=bots, ?mode=online)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const modeParam = params.get('mode');
      const teamParam = (params.get('team') === 'red' ? 'red' : 'blue') as 'red' | 'blue';
      const serverParam = params.get('server');
      if (serverParam) setServerUrl(serverParam);

      if (modeParam === 'spectator') {
        setSelectedTeam(teamParam);
        setGameMode('multiplayer');
        setTimeout(() => gameRef.current?.toggleSpectator(), 400);
      } else if (modeParam === 'bots' || modeParam === 'multiplayer') {
        setSelectedTeam(teamParam);
        setGameMode('multiplayer');
      } else if (modeParam === 'online') {
        setSelectedTeam(teamParam);
        setGameMode('online');
      } else if (modeParam === 'sandbox' || modeParam === 'singleplayer') {
        setSelectedTeam(teamParam);
        setGameMode('singleplayer');
      }
    } catch {
      // Ignore URL parsing errors in restricted sandbox environments
    }
  }, []);

  useEffect(() => {
    const handleLockChange = () => {
      setIsPointerLocked(!!document.pointerLockElement);
    };
    document.addEventListener('pointerlockchange', handleLockChange);
    return () => document.removeEventListener('pointerlockchange', handleLockChange);
  }, []);

  useEffect(() => {
    if (!canvasRef.current || gameRef.current || !gameMode) return;
    
    const canvas = canvasRef.current;
    console.log('Creating game with mode:', gameMode, 'team:', selectedTeam, 'server:', serverUrl, 'player:', playerName);
    
    // Ensure canvas has dimensions
    if (canvas.width === 0 || canvas.height === 0) {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    
    // Create game after a small delay to ensure canvas is ready
    setTimeout(() => {
      if (!canvasRef.current || gameRef.current) return;
      
      const game = new Game(canvasRef.current, gameMode, selectedTeam, serverUrl, playerName);
      game.onStateChange = (state) => setGameState(state);
      
      game.start();
      gameRef.current = game;
      console.log('Game created and started with mode:', gameMode, 'team:', selectedTeam);
      
      // Auto-start when game is created
      game.requestPointerLock(canvasRef.current);
      setStarted(true);
    }, 100);
    
    return () => { 
      console.log('Cleaning up game');
      if (gameRef.current) {
        gameRef.current.destroy(); 
        gameRef.current = null;
      }
    };
  }, [gameMode, selectedTeam, serverUrl, playerName]);

  const handleStart = (mode: 'multiplayer' | 'singleplayer' | 'online', team: 'red' | 'blue' = 'blue', targetServer?: string) => {
    setSelectedTeam(team);
    setServerUrl(targetServer);
    setGameMode(mode);
  };

  const handleDeployMultiplayer = () => {
    const target = serverType === 'custom' && customServerUrl.trim() ? customServerUrl.trim() : undefined;
    handleStart('online', modalTeam, target);
    setShowMultiplayerModal(false);
  };

  const copyInviteLink = (targetTeam?: 'red' | 'blue') => {
    try {
      const origin = window.location.origin;
      const pathname = window.location.pathname.replace(/\/$/, '');
      const team = targetTeam || (modalTeam === 'blue' ? 'red' : 'blue');
      let url = `${origin}${pathname}/?mode=online&team=${team}`;
      if (serverType === 'custom' && customServerUrl.trim()) {
        url += `&server=${encodeURIComponent(customServerUrl.trim())}`;
      }
      navigator.clipboard.writeText(url);
      setCopiedInvite(true);
      setTimeout(() => setCopiedInvite(false), 2500);
    } catch (err) {
      console.error('Failed to copy link', err);
    }
  };

  const handleCanvasClick = () => {
    if (canvasRef.current && gameRef.current && !document.pointerLockElement) {
      gameRef.current.requestPointerLock(canvasRef.current);
    }
  };

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (gameRef.current) gameRef.current.handleBuildClick();
  };

  const equipmentNames: Record<string, string> = {
    rifle: '🎯 Rifle', smg: '💨 SMG', spade: '🪣 Spade', pickaxe: '⛏️ Pickaxe',
  };
  const equipmentKeys: Record<string, string> = {
    rifle: '1', smg: '2', spade: '3', pickaxe: '4',
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black">
      <canvas ref={canvasRef} className="w-full h-full block" onClick={handleCanvasClick} onContextMenu={handleRightClick} />

      {!started && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-50">
          <div className="text-center max-w-3xl px-4">
            <h1 className="text-5xl font-bold text-white mb-1">🎮 Voxel FPS</h1>
            <div className="text-xs text-gray-500 font-mono mb-3">Version 1.4.0</div>
            <p className="text-lg text-gray-300 mb-1">Red vs Blue — Capture the Flag</p>
            <p className="text-sm text-gray-400 mb-6">You are <span className="text-blue-400 font-bold">BLUE</span> team. Push to the <span className="text-red-400 font-bold">RED</span> flag!</p>
            <div className="flex flex-wrap gap-3 justify-center mb-6">
              <button
                onClick={() => setShowMultiplayerModal(true)}
                className="px-6 py-3.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold text-lg rounded-xl hover:from-blue-500 hover:to-indigo-500 transition-all shadow-lg shadow-blue-600/30 cursor-pointer flex items-center gap-2.5"
              >
                <Globe className="w-5 h-5" /> <span>Multiplayer (Choose Server & Team)</span>
              </button>
              <button
                onClick={() => {
                  handleStart('online', 'blue');
                  setTimeout(() => {
                    const opposite = 'red';
                    window.open(window.location.origin + window.location.pathname + `?mode=online&team=${opposite}`, '_blank');
                  }, 400);
                }}
                className="px-5 py-3.5 bg-purple-600 hover:bg-purple-500 text-white font-bold text-base rounded-xl transition-all shadow-lg shadow-purple-600/30 cursor-pointer flex items-center gap-2"
                title="Launches this tab as Blue and opens a 2nd tab as Red to test 2-player multiplayer instantly!"
              >
                <Users className="w-5 h-5" /> <span>👥 Test 2-Player Match</span>
              </button>
              <button
                onClick={() => handleStart('multiplayer', 'blue')}
                className="px-6 py-3.5 bg-[#00ff88] text-black font-bold text-lg rounded-xl hover:bg-[#00cc66] transition-colors shadow-lg cursor-pointer"
              >
                🤖 Play vs Bots
              </button>
              <button
                onClick={() => { handleStart('multiplayer'); setTimeout(() => gameRef.current?.toggleSpectator(), 300); }}
                className="px-6 py-3.5 bg-indigo-600 text-white font-bold text-lg rounded-xl hover:bg-indigo-500 transition-colors shadow-lg cursor-pointer flex items-center gap-2"
              >
                <span>🎥</span> AI Spectator
              </button>
              <button
                onClick={() => handleStart('singleplayer')}
                className="px-5 py-3.5 bg-gray-700 text-gray-200 font-bold text-base rounded-xl hover:bg-gray-600 transition-colors shadow-lg cursor-pointer"
              >
                🧪 Free Sandbox
              </button>
            </div>
            
            <p className="text-xs text-purple-300/80 mb-2">
              💡 <b>Multiplayer Testing:</b> Click <b>Multiplayer</b> to select your server and team, or open in 2 tabs (one Blue, one Red) to test real-time CTF!
            </p>
            <div className="mt-6 bg-gray-900/60 rounded-xl p-5 text-left max-w-xl mx-auto text-sm">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h4 className="text-[#00ff88] font-bold mb-2">Movement</h4>
                  <p className="text-gray-300">WASD - Move</p>
                  <p className="text-gray-300">Mouse - Look</p>
                  <p className="text-gray-300">Space - Jump</p>
                  <p className="text-gray-300">Shift - Sprint</p>
                  <p className="text-gray-300">Ctrl/C - Crouch</p>
                </div>
                <div>
                  <h4 className="text-[#00ff88] font-bold mb-2">Equipment</h4>
                  <p className="text-gray-300"><b>1</b> 🎯 Rifle (WW2 iron sights)</p>
                  <p className="text-gray-300"><b>2</b> 💨 SMG (WW2 iron sights)</p>
                  <p className="text-gray-300"><b>3</b> 🪣 Spade (dig 2 blocks)</p>
                  <p className="text-gray-300"><b>4</b> ⛏️ Pickaxe (harvest)</p>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-700">
                <p className="text-gray-300"><b>Left Click</b> — Shoot / Use tool</p>
                <p className="text-gray-300"><b>Right Click</b> — Toggle iron sights / Place block (instant)</p>
                <p className="text-gray-300"><b>R</b> — Reload weapon</p>
                <p className="text-gray-300"><b>Mouse Wheel</b> — Switch equipment</p>
                <div className="mt-2 text-xs text-gray-400 space-y-1">
                  <p>🎯 1 headshot / 3 body shots to kill</p>
                  <p>🔫 Rifle: 10 rounds | SMG: 30 rounds (unlimited ammo)</p>
                  <p>🏃 Running + shooting = less accurate | 🧎 Crouching = more accurate</p>
                  <p>🏗️ <b>How to build:</b> Harvest blocks with pickaxe (4), then right-click to place instantly like Minecraft!</p>
                  <p>💥 All terrain is destroyable by gunfire (3 shots per voxel)</p>
                  <p>🧪 Singleplayer mode: No bots, test building & combat freely</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Multiplayer Server & Team Lobby Modal */}
      {showMultiplayerModal && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90 z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl max-w-xl w-full p-6 text-left shadow-2xl text-white">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-gray-800">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-blue-600/20 text-blue-400 rounded-xl border border-blue-500/30">
                  <Globe className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold">Multiplayer Server Lobby</h2>
                  <p className="text-xs text-gray-400">Select server, callsign, and team affiliation</p>
                </div>
              </div>
              <button
                onClick={() => setShowMultiplayerModal(false)}
                className="p-2 text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* 1. Server Choice */}
            <div className="mb-5">
              {isGitHubPages && (
                <div className="mb-3 p-3 bg-amber-950/40 border border-amber-800/40 rounded-xl text-xs text-amber-300 flex items-start gap-2">
                  <span className="text-base leading-none">ℹ️</span>
                  <span>
                    <strong>GitHub Pages Client:</strong> You are playing on static GitHub Pages. To play online multiplayer across the internet, enter your remote server URL (e.g., from Railway, Render, or VPS) below, or play <strong>Bot Match</strong> locally!
                  </span>
                </div>
              )}
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
                1. Choose Server
              </label>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <button
                  type="button"
                  onClick={() => setServerType('default')}
                  className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                    serverType === 'default'
                      ? 'bg-blue-950/40 border-blue-500 shadow-sm shadow-blue-500/20'
                      : 'bg-gray-800/60 border-gray-700 hover:border-gray-600'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-sm flex items-center gap-1.5">
                      <Server className="w-4 h-4 text-blue-400" /> Official Server
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded-full border border-emerald-800/40">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Online
                    </span>
                  </div>
                  <p className="text-xs text-gray-400">
                    Host: <span className="text-gray-300 font-mono">{typeof window !== 'undefined' ? (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host : 'ws://localhost:3000'}</span>
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setServerType('custom')}
                  className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
                    serverType === 'custom'
                      ? 'bg-purple-950/40 border-purple-500 shadow-sm shadow-purple-500/20'
                      : 'bg-gray-800/60 border-gray-700 hover:border-gray-600'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-sm flex items-center gap-1.5">
                      <Wifi className="w-4 h-4 text-purple-400" /> Custom Server
                    </span>
                    <span className="text-[11px] text-gray-400">External ws://</span>
                  </div>
                  <p className="text-xs text-gray-400">Connect to remote or private host</p>
                </button>
              </div>

              {serverType === 'custom' && (
                <div className="mt-2">
                  <input
                    type="text"
                    value={customServerUrl}
                    onChange={(e) => setCustomServerUrl(e.target.value)}
                    placeholder="ws://localhost:3000 or wss://..."
                    className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 font-mono"
                  />
                </div>
              )}
            </div>

            {/* 2. Player Callsign */}
            <div className="mb-5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
                2. Callsign / Player Name
              </label>
              <div className="relative">
                <Crosshair className="w-4 h-4 absolute left-3.5 top-3 text-gray-400" />
                <input
                  type="text"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  maxLength={18}
                  placeholder="Enter soldier name..."
                  className="w-full bg-gray-950 border border-gray-700 rounded-xl pl-10 pr-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {/* 3. Team Selection */}
            <div className="mb-5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
                3. Choose Your Team
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setModalTeam('blue')}
                  className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
                    modalTeam === 'blue'
                      ? 'bg-blue-900/40 border-blue-500 ring-2 ring-blue-500/50'
                      : 'bg-gray-800/40 border-gray-700 hover:border-gray-600'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-base text-blue-400 flex items-center gap-2">
                      <Shield className="w-5 h-5" /> BLUE TEAM
                    </span>
                    {modalTeam === 'blue' && <Check className="w-4 h-4 text-blue-400" />}
                  </div>
                  <p className="text-xs text-gray-300">Base at North (-95m). Capture South flag.</p>
                </button>

                <button
                  type="button"
                  onClick={() => setModalTeam('red')}
                  className={`p-4 rounded-xl border text-left transition-all cursor-pointer ${
                    modalTeam === 'red'
                      ? 'bg-red-900/40 border-red-500 ring-2 ring-red-500/50'
                      : 'bg-gray-800/40 border-gray-700 hover:border-gray-600'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-base text-red-400 flex items-center gap-2">
                      <Shield className="w-5 h-5" /> RED TEAM
                    </span>
                    {modalTeam === 'red' && <Check className="w-4 h-4 text-red-400" />}
                  </div>
                  <p className="text-xs text-gray-300">Base at South (+95m). Capture North flag.</p>
                </button>
              </div>
            </div>

            {/* 4. Play Over Internet Invite Link & Multi-Tab Test */}
            <div className="mb-6 p-3 bg-gray-950/80 border border-gray-800 rounded-xl space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-gray-300 font-semibold">
                  <Link2 className="w-4 h-4 text-indigo-400" />
                  <span>Play over Internet with a friend</span>
                </div>
                <button
                  type="button"
                  onClick={() => copyInviteLink(modalTeam === 'blue' ? 'red' : 'blue')}
                  className="px-3 py-1.5 bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/40 text-indigo-200 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copiedInvite ? 'Copied Link!' : `Copy Link (Join as ${modalTeam === 'blue' ? 'RED' : 'BLUE'})`}</span>
                </button>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-gray-800/80">
                <div className="flex items-center gap-2 text-xs text-emerald-300 font-semibold">
                  <Users className="w-4 h-4 text-emerald-400" />
                  <span>Test on this device (Instant 2-Player)</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const otherTeam = modalTeam === 'blue' ? 'red' : 'blue';
                    window.open(window.location.origin + window.location.pathname + `?mode=online&team=${otherTeam}`, '_blank');
                  }}
                  className="px-3 py-1.5 bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-500/40 text-emerald-200 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <Users className="w-3.5 h-3.5" />
                  <span>Open 2nd Player Tab ({modalTeam === 'blue' ? 'RED' : 'BLUE'})</span>
                </button>
              </div>

              <p className="text-[11px] text-gray-400">
                Supports real-time WebSocket, HTTP SSE fallback, and browser mesh sync. Open two tabs side-by-side to watch players shoot, build, and capture flags in real-time!
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-between pt-4 border-t border-gray-800">
              <button
                type="button"
                onClick={() => setShowMultiplayerModal(false)}
                className="px-4 py-2.5 text-gray-400 hover:text-white text-sm font-medium rounded-xl hover:bg-gray-800 transition-colors flex items-center gap-2 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" /> Cancel
              </button>

              <button
                type="button"
                onClick={handleDeployMultiplayer}
                className="px-6 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-base rounded-xl transition-all shadow-lg shadow-blue-600/30 flex items-center gap-2 cursor-pointer"
              >
                <Play className="w-4 h-4 fill-white" /> Connect & Deploy
              </button>
            </div>
          </div>
        </div>
      )}

      {started && (
        <>
          {/* Quick Preview & Spectator Toolbar (Top Left) */}
          <div className="absolute top-4 left-4 z-40 flex items-center gap-2">
            {!isPointerLocked && !gameState.isSpectating && (
              <div 
                onClick={handleCanvasClick}
                className="bg-gray-900/90 backdrop-blur-md px-3.5 py-2 rounded-xl border border-gray-700 text-xs text-gray-300 flex items-center gap-2 cursor-pointer hover:bg-gray-800 transition-colors shadow-lg"
                title="Click anywhere to lock pointer aim"
              >
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span><b>Click Canvas</b> to Lock Aim</span>
                <span className="text-gray-500">|</span>
                <span className="text-gray-400">Drag/Arrows to turn</span>
              </div>
            )}
            
            <button
              onClick={() => gameRef.current?.toggleSpectator()}
              className={`px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-lg cursor-pointer ${
                gameState.isSpectating
                  ? 'bg-indigo-600 hover:bg-indigo-500 text-white ring-2 ring-indigo-400'
                  : 'bg-gray-900/80 hover:bg-gray-800 text-gray-300 border border-gray-700'
              }`}
            >
              <span>🎥</span>
              <span>{gameState.isSpectating ? 'Exit Spectator (P)' : 'Spectate AI (P)'}</span>
            </button>

            {gameMode === 'online' && (
              <div className="bg-gray-900/90 backdrop-blur-md px-3 py-2 rounded-xl border border-emerald-500/40 text-xs text-gray-300 flex items-center gap-2 shadow-lg">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="text-emerald-400 font-bold">ONLINE</span>
                <button
                  type="button"
                  onClick={() => copyInviteLink(selectedTeam === 'blue' ? 'red' : 'blue')}
                  className="px-2 py-0.5 bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/50 rounded flex items-center gap-1 cursor-pointer transition-colors text-[11px] font-medium"
                  title="Copy Opponent Join Link to share with a friend"
                >
                  <Copy className="w-3 h-3" />
                  <span>{copiedInvite ? 'Copied!' : 'Invite Friend'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Spectator Mode Active Banner & Controls */}
          {gameState.isSpectating && (
            <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-2 pointer-events-auto">
              <div className="bg-indigo-950/90 border border-indigo-500/60 backdrop-blur-md px-4 py-2 rounded-2xl shadow-2xl flex items-center gap-3 text-xs text-indigo-100">
                <span className="w-2.5 h-2.5 rounded-full bg-indigo-400 animate-ping"></span>
                <span className="font-bold tracking-wide uppercase text-indigo-300">
                  {gameState.spectatorMode === 'free' ? '🦅 Free-Fly Drone Cam' : '🎯 Action Combat Cam'}
                </span>
                <span className="text-gray-500">|</span>
                <button
                  onClick={() => gameRef.current?.cycleSpectatorMode()}
                  className="px-2.5 py-1 bg-indigo-700/80 hover:bg-indigo-600 text-white rounded-lg font-semibold transition-colors cursor-pointer flex items-center gap-1"
                  title="Switch between Action Tracking and Free-Fly Drone Cam (C)"
                >
                  <span>🔄 Switch Mode (C)</span>
                </button>
                <button
                  onClick={() => gameRef.current?.toggleSpectator()}
                  className="px-2.5 py-1 bg-gray-800/80 hover:bg-gray-700 text-gray-200 rounded-lg font-semibold transition-colors cursor-pointer"
                  title="Return to Player (P)"
                >
                  Exit (P)
                </button>
              </div>

              {gameState.spectatorMode === 'action' && gameState.spectatorTrackedName && (
                <div className="bg-black/80 border border-indigo-500/40 backdrop-blur-md px-4 py-1.5 rounded-xl text-xs text-yellow-300 font-medium shadow-lg flex items-center gap-2">
                  <span>🔭 Focusing:</span>
                  <span className="text-white font-bold">{gameState.spectatorTrackedName}</span>
                </div>
              )}

              {gameState.spectatorMode === 'free' && (
                <div className="bg-black/85 border border-indigo-500/40 backdrop-blur-md px-4 py-1.5 rounded-xl text-[11px] text-gray-200 flex flex-wrap items-center justify-center gap-2.5 shadow-xl">
                  <span>🎮 <b>WASD / Arrows:</b> Fly & Pan</span>
                  <span className="text-gray-600">•</span>
                  <span><b>Space / E:</b> Up</span>
                  <span className="text-gray-600">•</span>
                  <span><b>Q / Shift:</b> Down</span>
                  <span className="text-gray-600">•</span>
                  <span><b>Shift:</b> Turbo</span>
                  <span className="text-gray-600">•</span>
                  <span><b>Drag / Lock:</b> Look</span>
                  <span className="text-gray-600">•</span>
                  <span><b>Wheel:</b> Speed</span>
                </div>
              )}
            </div>
          )}

          {/* Online Multiplayer Live Status */}
          {gameMode === 'online' && (
            <div className="absolute top-4 right-4 z-30 flex flex-col items-end gap-2 pointer-events-auto">
              <div className="bg-gray-900/90 backdrop-blur-md px-3.5 py-2 rounded-xl border border-purple-500/50 shadow-xl flex items-center gap-2.5 text-xs text-white">
                <span className={`w-2.5 h-2.5 rounded-full ${gameState.isNetworkConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`}></span>
                <span className="font-semibold">
                  {gameState.isNetworkConnected ? `Live: ${gameState.connectedPlayersCount || 1} Player${(gameState.connectedPlayersCount || 1) > 1 ? 's' : ''}` : 'Connecting...'}
                </span>
                {gameState.transportName && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-gray-800 text-purple-300 rounded font-mono font-bold">
                    {gameState.transportName}
                  </span>
                )}
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${selectedTeam === 'blue' ? 'bg-blue-950 text-blue-300 border border-blue-800' : 'bg-red-950 text-red-300 border border-red-800'}`}>
                  {selectedTeam} Team
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  const opposite = selectedTeam === 'blue' ? 'red' : 'blue';
                  window.open(window.location.origin + window.location.pathname + `?mode=online&team=${opposite}`, '_blank');
                }}
                className="px-3 py-1.5 bg-indigo-600/90 hover:bg-indigo-600 text-white rounded-lg border border-indigo-400/50 text-xs font-semibold shadow-lg transition-all flex items-center gap-1.5 cursor-pointer"
                title="Launch a 2nd player tab on this device to test Red vs Blue live multiplayer"
              >
                <Users className="w-3.5 h-3.5" />
                <span>👥 Open 2nd Player Tab ({selectedTeam === 'blue' ? 'RED' : 'BLUE'})</span>
              </button>
            </div>
          )}
          {/* Scoreboard - only in multiplayer */}
          {(gameMode === 'multiplayer' || gameMode === 'online') && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
              <div className="flex flex-col items-center gap-2">
                <div className="flex items-center bg-gray-900/90 rounded-xl overflow-hidden border-2 border-gray-700">
                  <div className="px-5 py-2 bg-blue-900/40 flex flex-col items-center gap-1">
                    <span className="text-blue-300 font-bold text-sm">BLUE</span>
                    <div className="flex items-center gap-3">
                      <div className="flex flex-col items-center">
                        <span className="text-gray-400 text-xs">Kills</span>
                        <span className="text-white font-bold text-xl">{gameState.blueKills}</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-gray-400 text-xs">Flags</span>
                        <span className="text-yellow-400 font-bold text-xl">{gameState.blueCaptures}</span>
                      </div>
                    </div>
                  </div>
                  <div className="px-3 py-2 text-gray-500 font-bold">VS</div>
                  <div className="px-5 py-2 bg-red-900/40 flex flex-col items-center gap-1">
                    <span className="text-red-300 font-bold text-sm">RED</span>
                    <div className="flex items-center gap-3">
                      <div className="flex flex-col items-center">
                        <span className="text-gray-400 text-xs">Kills</span>
                        <span className="text-white font-bold text-xl">{gameState.redKills}</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-gray-400 text-xs">Flags</span>
                        <span className="text-yellow-400 font-bold text-xl">{gameState.redCaptures}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Tactical Flag Status Badges */}
                <div className="flex items-center gap-2">
                  <div className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 border shadow-sm ${
                    gameState.blueFlagStatus === 'captured' ? 'bg-purple-950/80 text-purple-300 border-purple-500 animate-pulse' :
                    gameState.blueFlagStatus === 'carried' ? 'bg-amber-950/80 text-amber-300 border-amber-500' :
                    gameState.blueFlagStatus === 'dropped' ? 'bg-red-950/80 text-red-300 border-red-500 animate-pulse' :
                    'bg-blue-950/70 text-blue-300 border-blue-600/50'
                  }`}>
                    <span>🔵 Blue Flag:</span>
                    <span>
                      {gameState.blueFlagStatus === 'captured' ? `✨ Captured! (Respawn in ${Math.ceil(gameState.blueFlagTimer || 0)}s)` :
                       gameState.blueFlagStatus === 'carried' ? '🏃 Taken by Enemy!' :
                       gameState.blueFlagStatus === 'dropped' ? `⚠️ Dropped (${Math.ceil(gameState.blueFlagTimer || 0)}s)` :
                       '🛡️ At Base'}
                    </span>
                  </div>
                  <div className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 border shadow-sm ${
                    gameState.redFlagStatus === 'captured' ? 'bg-purple-950/80 text-purple-300 border-purple-500 animate-pulse' :
                    gameState.redFlagStatus === 'carried' ? 'bg-amber-950/80 text-amber-300 border-amber-500' :
                    gameState.redFlagStatus === 'dropped' ? 'bg-red-950/80 text-red-300 border-red-500 animate-pulse' :
                    'bg-red-950/70 text-red-300 border-red-600/50'
                  }`}>
                    <span>🔴 Red Flag:</span>
                    <span>
                      {gameState.redFlagStatus === 'captured' ? `✨ Captured! (Respawn in ${Math.ceil(gameState.redFlagTimer || 0)}s)` :
                       gameState.redFlagStatus === 'carried' ? '🏃 Taken by Enemy!' :
                       gameState.redFlagStatus === 'dropped' ? `⚠️ Dropped (${Math.ceil(gameState.redFlagTimer || 0)}s)` :
                       '🛡️ At Base'}
                    </span>
                  </div>
                </div>
                
                {/* Flag carrier indicator */}
                {gameState.flagCarrierName && (
                  <div className="bg-yellow-900/90 px-4 py-2 rounded-lg border-2 border-yellow-500 animate-pulse">
                    <span className="text-yellow-300 font-bold text-sm">
                      🚩 Flag Carrier: {gameState.flagCarrierName}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tactical Radio Comms Feed */}
          {gameState.radioLog && gameState.radioLog.length > 0 && (
            <div className="absolute top-20 left-8 z-10 max-w-xs pointer-events-none flex flex-col gap-1.5">
              <div className="text-[10px] uppercase font-mono tracking-wider text-gray-400 font-bold flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span>TACTICAL RADIO COMMS</span>
              </div>
              {gameState.radioLog.slice(-4).map((msg) => (
                <div
                  key={msg.id}
                  className={`px-2.5 py-1 rounded-lg text-xs backdrop-blur-md border flex flex-col transition-all ${
                    msg.team === 'blue'
                      ? 'bg-blue-950/80 text-blue-100 border-blue-600/40 shadow-sm'
                      : 'bg-red-950/80 text-red-100 border-red-600/40 shadow-sm'
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] font-bold opacity-90">
                    <span className={msg.team === 'blue' ? 'text-blue-300' : 'text-red-300'}>
                      [{msg.team.toUpperCase()}] {msg.sender}
                    </span>
                  </div>
                  <span className="text-gray-200 text-[11px] font-medium leading-snug">{msg.text}</span>
                </div>
              ))}
            </div>
          )}
          
          {/* Singleplayer mode indicator */}
          {gameMode === 'singleplayer' && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
              <div className="bg-blue-900/80 rounded-xl px-6 py-2 border-2 border-blue-600">
                <span className="text-blue-200 font-bold text-sm">🧪 SINGLEPLAYER MODE</span>
              </div>
            </div>
          )}

          {/* First-person gameplay HUD (hidden during spectator mode) */}
          {!gameState.isSpectating && (
            <>
              {/* Health */}
              <div className="absolute bottom-8 left-8 z-10">
                <div className="bg-gray-900/80 backdrop-blur-sm rounded-xl px-5 py-3 border-2 border-gray-700">
                  <div className="flex items-center gap-3">
                    <div className="w-32 h-3 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{
                        width: `${(gameState.hp / gameState.maxHp) * 100}%`,
                        background: gameState.hp > 50 ? '#00ff88' : gameState.hp > 25 ? '#ffcc00' : '#ff3366',
                      }}></div>
                    </div>
                    <span className="text-white font-bold text-lg">{gameState.hp}</span>
                  </div>
                </div>
              </div>

              {/* Equipment */}
              <div className="absolute bottom-8 right-8 z-10">
                <div className="bg-gray-900/80 backdrop-blur-sm rounded-xl px-5 py-3 border-2 border-gray-700">
                  <div className="space-y-1">
                    {(['rifle', 'smg', 'spade', 'pickaxe'] as const).map((item) => (
                      <div key={item} className={`flex items-center gap-2 px-2 py-1 rounded text-sm ${
                        gameState.equipment === item ? 'bg-[#00ff88]/20 text-[#00ff88]' : 'text-gray-400'
                      }`}>
                        <span className="font-mono w-3">{equipmentKeys[item]}</span>
                        <span>{equipmentNames[item]}</span>
                        {gameState.equipment === item && <span className="ml-auto">●</span>}
                      </div>
                    ))}
                  </div>
                  {(gameState.equipment === 'rifle' || gameState.equipment === 'smg') && (
                    <div className="text-xs text-gray-500 mt-2 pt-1 border-t border-gray-700">
                      {gameState.isAiming ? '🎯 Iron Sights' : 'Right-click to aim'}
                    </div>
                  )}
                </div>
              </div>

              {/* Ammo Counter */}
              {(gameState.equipment === 'rifle' || gameState.equipment === 'smg') && (
                <div className="absolute bottom-32 right-8 z-10">
                  <div className="bg-gray-900/80 backdrop-blur-sm rounded-xl px-5 py-3 border-2 border-gray-700">
                    <div className="text-gray-400 text-xs mb-1">Ammo</div>
                    <div className="flex items-baseline gap-2">
                      <span className={`text-2xl font-bold ${
                        (gameState.currentAmmo ?? 0) === 0 ? 'text-red-500' : 
                        (gameState.currentAmmo ?? 0) < (gameState.magazineSize ?? 10) * 0.3 ? 'text-yellow-500' : 
                        'text-white'
                      }`}>
                        {gameState.currentAmmo ?? 0}
                      </span>
                      <span className="text-gray-500 text-sm">/ {gameState.magazineSize ?? 0}</span>
                    </div>
                    {gameState.isReloading && (
                      <div className="text-xs text-yellow-500 mt-1 animate-pulse">
                        🔄 Reloading...
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Inventory */}
              <div className="absolute top-8 right-8 z-10">
                <div className="bg-gray-900/80 backdrop-blur-sm rounded-xl px-5 py-3 border-2 border-gray-700">
                  <div className="text-gray-400 text-xs">Inventory</div>
                  <div className="text-white font-bold text-xl">📦 {gameState.inventory}</div>
                </div>
              </div>

              {/* Dynamic Tactical Crosshair & Iron Sight Reticle */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-20">
                {gameState.isAiming ? (
                  /* High-precision ADS reticle */
                  <div className="relative w-12 h-12">
                    <div className="absolute inset-0 rounded-full border border-white/40"></div>
                    <div className="absolute inset-2 rounded-full border border-dashed border-white/20"></div>
                    <div className={`absolute top-1/2 left-0 w-4 h-0.5 -translate-y-1/2 ${gameState.targetInfo ? 'bg-red-400' : 'bg-emerald-400'}`}></div>
                    <div className={`absolute top-1/2 right-0 w-4 h-0.5 -translate-y-1/2 ${gameState.targetInfo ? 'bg-red-400' : 'bg-emerald-400'}`}></div>
                    <div className={`absolute left-1/2 top-0 w-0.5 h-4 -translate-x-1/2 ${gameState.targetInfo ? 'bg-red-400' : 'bg-emerald-400'}`}></div>
                    <div className={`absolute left-1/2 bottom-0 w-0.5 h-4 -translate-x-1/2 ${gameState.targetInfo ? 'bg-red-400' : 'bg-emerald-400'}`}></div>
                    <div className={`absolute top-1/2 left-1/2 w-1.5 h-1.5 rounded-full -translate-x-1/2 -translate-y-1/2 shadow-sm ${
                      gameState.targetInfo ? 'bg-red-500 shadow-red-500/80 scale-125' : 'bg-emerald-400 shadow-emerald-400/80'
                    }`}></div>
                  </div>
                ) : (
                  /* Hipfire crosshair */
                  <div className="relative w-8 h-8">
                    <div className={`absolute top-1/2 left-0 w-3 h-0.5 -translate-y-1/2 ${gameState.targetInfo ? 'bg-red-400' : 'bg-white'}`}></div>
                    <div className={`absolute top-1/2 right-0 w-3 h-0.5 -translate-y-1/2 ${gameState.targetInfo ? 'bg-red-400' : 'bg-white'}`}></div>
                    <div className={`absolute left-1/2 top-0 w-0.5 h-3 -translate-x-1/2 ${gameState.targetInfo ? 'bg-red-400' : 'bg-white'}`}></div>
                    <div className={`absolute left-1/2 bottom-0 w-0.5 h-3 -translate-x-1/2 ${gameState.targetInfo ? 'bg-red-400' : 'bg-white'}`}></div>
                    <div className={`absolute top-1/2 left-1/2 w-1 h-1 rounded-full -translate-x-1/2 -translate-y-1/2 ${
                      gameState.targetInfo ? 'bg-red-500 ring-2 ring-red-400/50' : 'bg-white'
                    }`}></div>
                  </div>
                )}
              </div>

              {/* Dynamic Target Range & Headshot HUD Info */}
              {gameState.targetInfo && (
                <div className="absolute top-[56%] left-1/2 -translate-x-1/2 z-20 pointer-events-none">
                  <div className="bg-black/85 backdrop-blur-md rounded-full px-3.5 py-1 border border-red-500/60 shadow-xl flex items-center gap-1.5 animate-pulse">
                    <span className="text-[11px] font-mono font-semibold tracking-wide text-red-200">
                      {gameState.targetInfo}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Hit marker - flashes red on target hit, auto-fades */}
          {gameState.hitMarker && !gameState.isSpectating && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-30">
              <div className="w-6 h-6 relative">
                <div className="absolute top-0 left-0 w-2.5 h-0.5 bg-red-500 shadow-[0_0_6px_#ef4444] rotate-45 origin-left"></div>
                <div className="absolute top-0 right-0 w-2.5 h-0.5 bg-red-500 shadow-[0_0_6px_#ef4444] -rotate-45 origin-right"></div>
                <div className="absolute bottom-0 left-0 w-2.5 h-0.5 bg-red-500 shadow-[0_0_6px_#ef4444] -rotate-45 origin-left"></div>
                <div className="absolute bottom-0 right-0 w-2.5 h-0.5 bg-red-500 shadow-[0_0_6px_#ef4444] rotate-45 origin-right"></div>
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-red-500 shadow-[0_0_8px_#ef4444]"></div>
              </div>
            </div>
          )}

          {/* Message */}
          {gameState.message && gameState.messageTimer > 0 && (
            <div className="absolute top-1/3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
              <div className="bg-gray-900/80 backdrop-blur-sm rounded-xl px-6 py-3 border border-gray-700">
                <p className="text-white font-medium text-center">{gameState.message}</p>
              </div>
            </div>
          )}

          {/* Death screen */}
          {gameState.isDead && !gameState.isSpectating && (
            <div className="absolute inset-0 flex items-center justify-center bg-red-950/60 backdrop-blur-sm z-30">
              <div className="text-center bg-gray-900/90 border border-red-500/40 p-8 rounded-2xl shadow-2xl max-w-md mx-4">
                <h2 className="text-4xl font-extrabold text-red-500 mb-2 tracking-tight">☠️ ELIMINATED</h2>
                <p className="text-gray-300 font-medium mb-1">
                  Respawning at base in <span className="text-white font-bold text-lg">{Math.ceil(gameState.respawnTimer)}s</span>
                </p>
                <p className="text-gray-400 text-xs mb-5">BLUE {gameState.blueKills} — {gameState.redKills} RED</p>
                
                <button
                  onClick={() => gameRef.current?.toggleSpectator()}
                  className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm rounded-xl transition-all shadow-lg cursor-pointer flex items-center justify-center gap-2 mx-auto"
                >
                  <span>🎥</span>
                  <span>Spectate Battle While Waiting (P)</span>
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;
