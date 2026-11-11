'use client';

// src/voice/useVoiceEngine.js
/**
 * Prodrome Labs Next.js 14 SSR-Safe React Hook & Adapter (Phase 2.5 Synchronized)
 * Feature Branch: feature/voice-pipeline
 * 
 * Provides reactive bindings for Person 4's Next.js 14 App Router UI,
 * guarding all browser audio APIs against server-side hydration errors.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { VoiceEngine } from './VoiceEngine.js';

export function useVoiceEngine(config = {}) {
  const [engineState, setEngineState] = useState('IDLE');
  const [language, setLanguageState] = useState(config.language || 'en-US');
  const [transcript, setTranscript] = useState({ interim: '', final: '' });
  const [verifiedTranscript, setVerifiedTranscript] = useState('');
  const [telemetry, setTelemetry] = useState({
    vadSilenceMs: 0,
    bargeInLatencyMs: 0,
    ttfaMs: 0,
    wavPayloadKb: 0,
    currentRms: 0,
    arousal: 0.40,
    valence: 0.50
  });
  const [lastDispatchedAction, setLastDispatchedAction] = useState(null);
  const [extractedSlots, setExtractedSlots] = useState({
    phq9Estimate: 0,
    gad7Estimate: 0,
    somaticFlags: []
  });
  const [bargeInSensitivity, setBargeInSensitivityState] = useState(config.bargeInSensitivity || 'LOW');
  const [pauseTolerance, setPauseToleranceState] = useState(config.pauseToleranceMs || 1400);
  const [pauseProgress, setPauseProgress] = useState({ remainingMs: 0, totalMs: 0, percent: 0 });
  const [serverConfig, setServerConfig] = useState({
    ttsTier: 'Detecting...',
    azureConfigured: false,
    azureRegion: 'eastus',
    groqConfigured: false,
    hotlines: {
      primary: '800-SAKINA (800 968)',
      secondary: 'Istijaba (800 1717)'
    },
    snomedMatrix: {
      chestTightness: '271795006',
      terminalInsomnia: '193462001'
    },
    loincScales: {
      phq9: '44249-1',
      gad7: '69737-5',
      cssrs: '93250-9'
    }
  });
  const [isSessionActive, setIsSessionActive] = useState(false);

  const engineRef = useRef(null);

  // Initialize engine only on client mount
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const engine = new VoiceEngine({
      wsUrl: config.wsUrl || process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8001/ws/voice',
      language: language,
      onStateChange: (newState) => {
        setEngineState(newState);
      },
      bargeInSensitivity: bargeInSensitivity,
      pauseToleranceMs: pauseTolerance,
      onPauseProgress: (remainingMs, totalMs, percent) => {
        setPauseProgress({ remainingMs, totalMs, percent });
      },
      onTelemetryUpdate: (metrics) => {
        setTelemetry((prev) => ({
          ...prev,
          vadSilenceMs: metrics.vadSilenceTriggerMs || prev.vadSilenceMs,
          bargeInLatencyMs: metrics.bargeInHaltLatencyMs !== undefined ? metrics.bargeInHaltLatencyMs : prev.bargeInLatencyMs,
          ttfaMs: metrics.timeToFirstAudioMs || prev.ttfaMs,
          wavPayloadKb: metrics.lastWavPayloadSizeKB || prev.wavPayloadKb,
          currentRms: metrics.currentRms || prev.currentRms,
          arousal: metrics.arousal !== undefined ? metrics.arousal : prev.arousal,
          valence: metrics.valence !== undefined ? metrics.valence : prev.valence
        }));
      },
      onRmsUpdate: (rms) => {
        setTelemetry((prev) => ({ ...prev, currentRms: rms }));
      },
      onTranscriptUpdate: ({ final, interim }) => {
        setTranscript({ final: final || '', interim: interim || '' });
      },
      onTranscriptFinalized: ({ transcript }) => {
        setVerifiedTranscript(transcript || '');
      },
      onServerConfig: (srvCfg) => {
        setServerConfig({
          ttsTier: srvCfg.tts_tier,
          azureConfigured: srvCfg.azure_configured,
          azureRegion: srvCfg.azure_region,
          groqConfigured: srvCfg.groq_configured,
          hotlines: srvCfg.hotlines,
          snomedMatrix: srvCfg.snomed_matrix,
          loincScales: srvCfg.loinc_scales
        });
      },
      onDispatchedAction: (actionData) => {
        setLastDispatchedAction(actionData);
      },
      onSlotsUpdate: (slots) => {
        setExtractedSlots({
          phq9Estimate: slots.phq9_estimate || 0,
          gad7Estimate: slots.gad7_estimate || 0,
          somaticFlags: slots.somatic_flags || []
        });
      },
      onEmergencyAction: (payload) => {
        setLastDispatchedAction({
          event: 'DISPATCH_ACTION',
          action_type: 'HARD_EMERGENCY_OVERRIDE',
          payload
        });
      }
    });

    engineRef.current = engine;

    return () => {
      if (engineRef.current) {
        engineRef.current.stopSession();
        engineRef.current = null;
      }
    };
  }, []);

  const startSession = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!engineRef.current) return;
    try {
      await engineRef.current.startSession();
      setIsSessionActive(true);
    } catch (err) {
      console.error('[useVoiceEngine] Failed to start session:', err);
      setIsSessionActive(false);
      throw err;
    }
  }, []);

  const stopSession = useCallback(() => {
    if (!engineRef.current) return;
    engineRef.current.stopSession();
    setIsSessionActive(false);
    setEngineState('IDLE');
  }, []);

  const setLanguage = useCallback((newLang) => {
    setLanguageState(newLang);
    if (engineRef.current) {
      engineRef.current.setLanguage(newLang);
    }
  }, []);

  const setBargeInSensitivity = useCallback((mode) => {
    setBargeInSensitivityState(mode);
    if (engineRef.current) {
      engineRef.current.setBargeInSensitivity(mode);
    }
  }, []);

  const setPauseTolerance = useCallback((ms) => {
    setPauseToleranceState(ms);
    if (engineRef.current) {
      engineRef.current.setPauseTolerance(ms);
    }
  }, []);

  const commitTurnImmediately = useCallback(() => {
    if (engineRef.current) {
      engineRef.current.commitTurnImmediately();
    }
  }, []);

  const resetSessionMemory = useCallback(() => {
    if (engineRef.current) {
      engineRef.current.resetSessionMemory();
      setExtractedSlots({ phq9Estimate: 0, gad7Estimate: 0, somaticFlags: [] });
    }
  }, []);

  const triggerManualBargeIn = useCallback(() => {
    if (engineRef.current) {
      engineRef.current.triggerManualBargeIn();
    }
  }, []);

  const simulatePerson2Action = useCallback((simulationType) => {
    if (engineRef.current) {
      engineRef.current.simulatePerson2Action(simulationType);
    }
  }, []);

  const getFrequencyData = useCallback(() => {
    if (engineRef.current) {
      return engineRef.current.getFrequencyData();
    }
    return new Uint8Array(64);
  }, []);

  const hasIncompleteClause = useCallback((text) => {
    if (engineRef.current) {
      return engineRef.current.hasIncompleteClause(text);
    }
    return false;
  }, []);

  return {
    state: engineState,
    language,
    setLanguage,
    transcript,
    verifiedTranscript,
    telemetry,
    serverConfig,
    lastDispatchedAction,
    extractedSlots,
    bargeInSensitivity,
    setBargeInSensitivity,
    pauseTolerance,
    setPauseTolerance,
    pauseProgress,
    commitTurnImmediately,
    resetSessionMemory,
    hasIncompleteClause,
    isSessionActive,
    startSession,
    stopSession,
    triggerManualBargeIn,
    simulatePerson2Action,
    getFrequencyData
  };
}
