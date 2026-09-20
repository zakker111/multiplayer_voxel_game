export class SoundManager {
  private audioContext: AudioContext | null = null;
  private enabled: boolean = true;

  constructor() {
    const initAudio = () => {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        // Resume audio context if it's suspended
        if (this.audioContext.state === 'suspended') {
          this.audioContext.resume();
        }
      }
      document.removeEventListener('click', initAudio);
      document.removeEventListener('keydown', initAudio);
    };
    document.addEventListener('click', initAudio);
    document.addEventListener('keydown', initAudio);
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  private playTone(frequency: number, duration: number, volume: number = 0.3, type: OscillatorType = 'sine') {
    if (!this.enabled || !this.audioContext) return;

    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = type;

    gainNode.gain.setValueAtTime(volume, this.audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);

    oscillator.start(this.audioContext.currentTime);
    oscillator.stop(this.audioContext.currentTime + duration);
  }

  private playNoise(duration: number, volume: number = 0.3) {
    if (!this.enabled || !this.audioContext) return;

    const bufferSize = this.audioContext.sampleRate * duration;
    const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();

    source.buffer = buffer;
    source.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    gainNode.gain.setValueAtTime(volume, this.audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);

    source.start();
  }

  rifleShot() {
    this.playNoise(0.1, 0.4);
    this.playTone(150, 0.05, 0.3, 'square');
  }

  smgShot() {
    this.playNoise(0.08, 0.3);
    this.playTone(200, 0.03, 0.2, 'square');
  }

  hitMarker() {
    this.playTone(800, 0.1, 0.2, 'sine');
  }

  killSound() {
    this.playTone(600, 0.1, 0.3, 'sine');
    setTimeout(() => this.playTone(800, 0.1, 0.3, 'sine'), 100);
  }

  pickaxeHit() {
    this.playNoise(0.15, 0.2);
    this.playTone(300, 0.1, 0.2, 'triangle');
  }

  spadeHit() {
    this.playNoise(0.1, 0.15);
    this.playTone(250, 0.08, 0.15, 'triangle');
  }

  buildPlace() {
    this.playTone(400, 0.1, 0.2, 'sine');
    this.playTone(500, 0.1, 0.2, 'sine');
  }

  voxelBreak() {
    this.playNoise(0.2, 0.25);
    this.playTone(200, 0.15, 0.2, 'sawtooth');
  }

  collapse() {
    this.playNoise(0.5, 0.4);
    this.playTone(100, 0.3, 0.3, 'sawtooth');
  }

  jump() {
    this.playTone(300, 0.1, 0.1, 'sine');
  }

  death() {
    this.playTone(200, 0.3, 0.3, 'sawtooth');
    setTimeout(() => this.playTone(150, 0.3, 0.3, 'sawtooth'), 200);
  }

  respawn() {
    this.playTone(400, 0.1, 0.2, 'sine');
    setTimeout(() => this.playTone(600, 0.1, 0.2, 'sine'), 100);
    setTimeout(() => this.playTone(800, 0.1, 0.2, 'sine'), 200);
  }

  capture() {
    // Triumphant ascending sequence for flag capture
    this.playTone(523, 0.15, 0.3, 'sine'); // C5
    setTimeout(() => this.playTone(659, 0.15, 0.3, 'sine'), 150); // E5
    setTimeout(() => this.playTone(784, 0.15, 0.3, 'sine'), 300); // G5
    setTimeout(() => this.playTone(1047, 0.3, 0.4, 'sine'), 450); // C6
    // Celebratory firework bursts
    setTimeout(() => this.captureFirework(), 500);
    setTimeout(() => this.captureFirework(), 800);
  }

  captureFirework() {
    this.playNoise(0.25, 0.35);
    this.playTone(450, 0.2, 0.25, 'triangle');
    setTimeout(() => this.playTone(900, 0.15, 0.2, 'sine'), 80);
  }

  radioBeep() {
    this.playTone(1760, 0.035, 0.12, 'sine');
    setTimeout(() => this.playTone(2200, 0.04, 0.10, 'sine'), 40);
  }

  weaponSwitch() {
    this.playTone(500, 0.05, 0.15, 'sine');
  }

  reload() {
    // Magazine out sound
    this.playNoise(0.1, 0.2);
    this.playTone(300, 0.08, 0.15, 'square');
    
    // Magazine in sound (delayed)
    setTimeout(() => {
      this.playNoise(0.1, 0.25);
      this.playTone(400, 0.1, 0.2, 'square');
    }, 800);
  }

  playSoundAtVolume(soundType: 'rifle' | 'smg', volume: number) {
    if (soundType === 'rifle') {
      this.playNoise(0.1, 0.4 * volume);
      this.playTone(150, 0.05, 0.3 * volume, 'square');
    } else if (soundType === 'smg') {
      this.playNoise(0.08, 0.3 * volume);
      this.playTone(200, 0.03, 0.2 * volume, 'square');
    }
  }

  // Spatial audio for distant gunshots with panning
  playDistantShot(weaponType: 'rifle' | 'smg', distance: number, direction: number) {
    if (!this.enabled || !this.audioContext) return;
    
    // Volume based on distance (fade out after 100 units)
    const maxDistance = 100;
    const volume = Math.max(0, 1 - distance / maxDistance) * 0.6;
    
    if (volume < 0.05) return; // Too far away
    
    // Create panner for spatial audio
    const panner = this.audioContext.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, direction)); // -1 = left, 1 = right
    
    if (weaponType === 'rifle') {
      // Rifle: deeper, more echoey sound
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.audioContext.destination);
      
      osc.frequency.value = 120;
      osc.type = 'sawtooth';
      
      gain.gain.setValueAtTime(volume * 0.3, this.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);
      
      osc.start();
      osc.stop(this.audioContext.currentTime + 0.15);
      
      // Add noise layer
      this.playSpatialNoise(0.12, volume * 0.4, direction);
    } else {
      // SMG: higher pitched, quicker
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(this.audioContext.destination);
      
      osc.frequency.value = 180;
      osc.type = 'square';
      
      gain.gain.setValueAtTime(volume * 0.25, this.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.08);
      
      osc.start();
      osc.stop(this.audioContext.currentTime + 0.08);
      
      // Add noise layer
      this.playSpatialNoise(0.08, volume * 0.3, direction);
    }
  }

  // Spatial noise with panning
  private playSpatialNoise(duration: number, volume: number, pan: number) {
    if (!this.audioContext) return;
    
    const bufferSize = this.audioContext.sampleRate * duration;
    const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.5;
    }
    
    const source = this.audioContext.createBufferSource();
    const gain = this.audioContext.createGain();
    const panner = this.audioContext.createStereoPanner();
    
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.audioContext.destination);
    
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    
    gain.gain.setValueAtTime(volume, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);
    
    source.start();
  }

  // Bullet whizzing sound when bullet passes near player
  bulletWhizz(distance: number, direction: number) {
    if (!this.enabled || !this.audioContext) return;
    
    // Only play if bullet passed close (within 3 units)
    if (distance > 3) return;
    
    // Volume based on how close the bullet passed
    const volume = Math.max(0, 1 - distance / 3) * 0.5;
    
    if (volume < 0.05) return;
    
    // Create panner for spatial audio
    const panner = this.audioContext.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, direction));
    
    // High-pitched whizzing sound
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.audioContext.destination);
    
    // Frequency sweep for whizzing effect
    osc.frequency.setValueAtTime(2000, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(800, this.audioContext.currentTime + 0.15);
    osc.type = 'sine';
    
    gain.gain.setValueAtTime(volume, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);
    
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.15);
    
    // Add noise layer for realism
    this.playSpatialNoise(0.1, volume * 0.3, direction);
  }

  // Bullet impact sound when bullet hits nearby surface
  bulletImpact(distance: number, direction: number) {
    if (!this.enabled || !this.audioContext) return;
    
    // Only play if impact is within 20 units
    if (distance > 20) return;
    
    const volume = Math.max(0, 1 - distance / 20) * 0.4;
    
    if (volume < 0.05) return;
    
    // Create panner for spatial audio
    const panner = this.audioContext.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, direction));
    
    // Impact sound: short noise burst
    const bufferSize = this.audioContext.sampleRate * 0.08;
    const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.3));
    }
    
    const source = this.audioContext.createBufferSource();
    const gain = this.audioContext.createGain();
    
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.audioContext.destination);
    
    gain.gain.setValueAtTime(volume, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.08);
    
    source.start();
  }

  hurt() {
    this.playTone(180, 0.12, 0.35, 'sawtooth');
    this.playNoise(0.08, 0.25);
  }

  headshot() {
    this.playTone(1200, 0.08, 0.35, 'sine');
    setTimeout(() => this.playTone(1600, 0.1, 0.4, 'sine'), 60);
  }

  deathSound() {
    this.death();
  }

  flagPickup() {
    this.playTone(600, 0.1, 0.3, 'sine');
    setTimeout(() => this.playTone(900, 0.15, 0.35, 'sine'), 100);
  }

  flagAlarm() {
    this.playTone(400, 0.15, 0.3, 'sawtooth');
    setTimeout(() => this.playTone(300, 0.15, 0.3, 'sawtooth'), 150);
  }

  flagCapture() {
    this.capture();
  }

  bulletWhiz(pan: number = 0) {
    if (!this.enabled || !this.audioContext) return;
    const panner = this.audioContext.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));

    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.audioContext.destination);

    // Fast Doppler sonic snap/whiz
    osc.frequency.setValueAtTime(2400, this.audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(700, this.audioContext.currentTime + 0.09);
    osc.type = 'sine';

    gain.gain.setValueAtTime(0.18, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.09);

    osc.start();
    osc.stop(this.audioContext.currentTime + 0.09);
  }

  // Footstep sound for remote players in multiplayer
  playFootstepRemote(volume: number, pitch: number, pan: number) {
    if (!this.enabled || !this.audioContext) return;
    
    const panner = this.audioContext.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    
    // Create footstep sound with noise and tone
    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(this.audioContext.destination);
    
    osc.frequency.value = 100 + pitch * 50;
    osc.type = 'triangle';
    
    gain.gain.setValueAtTime(volume * 0.3, this.audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
    
    osc.start();
    osc.stop(this.audioContext.currentTime + 0.1);
    
    // Add noise layer for footstep texture
    this.playSpatialNoise(0.08, volume * 0.2, pan);
  }
}
