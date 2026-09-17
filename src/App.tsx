import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { NetworkClient } from './game/networkClient';

const App: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [gameState, setGameState] = useState<{ scores: { red: number; blue: number }; timeRemaining: number } | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [showMenu, setShowMenu] = useState(true);
  const [playerName, setPlayerName] = useState('');
  const [selectedTeam, setSelectedTeam] = useState<'red' | 'blue'>('blue');
  
  const networkRef = useRef<NetworkClient | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const playerRef = useRef({ x: 0, y: 10, z: -120, yaw: 0, pitch: 0 });

  useEffect(() => {
    networkRef.current = new NetworkClient();
    
    networkRef.current.onGameState((state) => {
      setGameState({ scores: state.scores, timeRemaining: state.timeRemaining });
      setIsConnected(true);
    });

    networkRef.current.onError((error) => {
      console.error('Network error:', error);
    });

    return () => {
      networkRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current || !showMenu) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 50, 300);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 10, -120);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(100, 200, 100);
    directionalLight.castShadow = true;
    scene.add(directionalLight);

    // Ground
    const groundGeometry = new THREE.PlaneGeometry(400, 400);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x3d8c40 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    scene.add(ground);

    // Blue Base
    const blueBaseGeo = new THREE.BoxGeometry(40, 20, 40);
    const blueBaseMat = new THREE.MeshStandardMaterial({ color: 0x0000ff });
    const blueBase = new THREE.Mesh(blueBaseGeo, blueBaseMat);
    blueBase.position.set(0, 10, -100);
    blueBase.castShadow = true;
    scene.add(blueBase);

    // Red Base
    const redBaseGeo = new THREE.BoxGeometry(40, 20, 40);
    const redBaseMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const redBase = new THREE.Mesh(redBaseGeo, redBaseMat);
    redBase.position.set(0, 10, 100);
    redBase.castShadow = true;
    scene.add(redBase);

    // Flag poles
    const poleGeo = new THREE.CylinderGeometry(0.5, 0.5, 15);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x8b4513 });
    
    const bluePole = new THREE.Mesh(poleGeo, poleMat);
    bluePole.position.set(0, 7.5, -95);
    scene.add(bluePole);

    const redPole = new THREE.Mesh(poleGeo, poleMat);
    redPole.position.set(0, 7.5, 95);
    scene.add(redPole);

    // Flags
    const flagGeo = new THREE.BoxGeometry(4, 3, 0.5);
    
    const blueFlagMat = new THREE.MeshStandardMaterial({ color: 0x0000ff });
    const blueFlag = new THREE.Mesh(flagGeo, blueFlagMat);
    blueFlag.position.set(2, 13, -95);
    scene.add(blueFlag);

    const redFlagMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const redFlag = new THREE.Mesh(flagGeo, redFlagMat);
    redFlag.position.set(2, 13, 95);
    scene.add(redFlag);

    // Random obstacles
    for (let i = 0; i < 30; i++) {
      const size = Math.random() * 8 + 4;
      const obsGeo = new THREE.BoxGeometry(size, size, size);
      const obsMat = new THREE.MeshStandardMaterial({ 
        color: new THREE.Color().setHSL(Math.random(), 0.7, 0.5) 
      });
      const obstacle = new THREE.Mesh(obsGeo, obsMat);
      obstacle.position.set(
        (Math.random() - 0.5) * 200,
        size / 2,
        (Math.random() - 0.5) * 200
      );
      // Keep away from bases
      if (Math.abs(obstacle.position.z) > 60 || Math.abs(obstacle.position.x) > 30) {
        obstacle.castShadow = true;
        obstacle.receiveShadow = true;
        scene.add(obstacle);
      }
    }

    const handleResize = () => {
      if (cameraRef.current && rendererRef.current) {
        cameraRef.current.aspect = window.innerWidth / window.innerHeight;
        cameraRef.current.updateProjectionMatrix();
        rendererRef.current.setSize(window.innerWidth, window.innerHeight);
      }
    };

    window.addEventListener('resize', handleResize);

    const animate = () => {
      requestAnimationFrame(animate);
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };

    animate();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (rendererRef.current && containerRef.current) {
        containerRef.current.removeChild(rendererRef.current.domElement);
      }
    };
  }, [showMenu]);

  const joinGame = async () => {
    if (!playerName.trim()) return;
    
    try {
      await networkRef.current?.connect();
      networkRef.current?.send({ 
        type: 'join', 
        name: playerName, 
        team: selectedTeam 
      });
      setShowMenu(false);
      setIsConnected(true);
    } catch (e) {
      console.error('Failed to join:', e);
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', margin: 0, overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      
      {showMenu && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.8)',
          padding: '40px',
          borderRadius: '10px',
          color: 'white',
          textAlign: 'center',
          fontFamily: 'Arial, sans-serif'
        }}>
          <h1 style={{ marginBottom: '30px', fontSize: '36px' }}>VOXEL FPS CTF</h1>
          
          <input
            type="text"
            placeholder="Enter your name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            style={{
              padding: '12px',
              fontSize: '18px',
              marginBottom: '20px',
              width: '250px',
              borderRadius: '5px',
              border: 'none'
            }}
          />
          
          <div style={{ marginBottom: '20px' }}>
            <p style={{ marginBottom: '10px' }}>Select Team:</p>
            <button
              onClick={() => setSelectedTeam('blue')}
              style={{
                padding: '10px 20px',
                margin: '0 10px',
                fontSize: '16px',
                background: selectedTeam === 'blue' ? '#0000ff' : '#333',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer'
              }}
            >
              BLUE
            </button>
            <button
              onClick={() => setSelectedTeam('red')}
              style={{
                padding: '10px 20px',
                margin: '0 10px',
                fontSize: '16px',
                background: selectedTeam === 'red' ? '#ff0000' : '#333',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer'
              }}
            >
              RED
            </button>
          </div>
          
          <button
            onClick={joinGame}
            disabled={!playerName.trim()}
            style={{
              padding: '15px 40px',
              fontSize: '20px',
              background: playerName.trim() ? '#4CAF50' : '#666',
              color: 'white',
              border: 'none',
              borderRadius: '5px',
              cursor: playerName.trim() ? 'pointer' : 'not-allowed'
            }}
          >
            JOIN GAME
          </button>
          
          {!isConnected && networkRef.current?.isSinglePlayer && (
            <p style={{ marginTop: '20px', color: '#ffa500' }}>
              Single Player Mode (No server available)
            </p>
          )}
        </div>
      )}

      {gameState && !showMenu && (
        <div style={{
          position: 'absolute',
          top: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.7)',
          padding: '15px 30px',
          borderRadius: '5px',
          color: 'white',
          fontFamily: 'Arial, sans-serif',
          fontSize: '24px',
          display: 'flex',
          gap: '30px'
        }}>
          <span style={{ color: '#ff4444' }}>RED: {gameState.scores.red}</span>
          <span>|</span>
          <span style={{ color: '#4444ff' }}>BLUE: {gameState.scores.blue}</span>
          <span>|</span>
          <span>{Math.floor(gameState.timeRemaining / 60)}:{(gameState.timeRemaining % 60).toString().padStart(2, '0')}</span>
        </div>
      )}

      {!showMenu && (
        <div style={{
          position: 'absolute',
          bottom: '20px',
          left: '20px',
          color: 'white',
          fontFamily: 'Arial, sans-serif',
          fontSize: '14px',
          background: 'rgba(0,0,0,0.5)',
          padding: '10px',
          borderRadius: '5px'
        }}>
          <p>WASD - Move | Mouse - Look | Click - Shoot</p>
          <p>R - Respawn | ESC - Menu</p>
        </div>
      )}
    </div>
  );
};

export default App;
