import { useCallback, useEffect, useMemo, useState } from "react";
import {
  decodeSurveyStorage,
  mergeSurveyStates,
  mergeSurveyStatesForPersistence,
  migrateSurveyState,
  normalizeSurveySessionName,
  SURVEY_STORAGE_VERSION,
} from "../utils/survey.js";

const STORAGE_KEY = "wifi-mesh-visualizer:surveys";
let fallbackSequence = 0;

function makeId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  fallbackSequence += 1;
  return `${prefix}-${Date.now()}-${fallbackSequence}`;
}

function loadState() {
  let stored;
  try {
    stored = globalThis.localStorage?.getItem(STORAGE_KEY);
  } catch (error) {
    return {
      state: migrateSurveyState(null),
      error: `Saved survey history is inaccessible and was left untouched: ${
        error instanceof Error ? error.message : String(error)
      }`,
      blocked: true,
    };
  }

  return decodeSurveyStorage(stored);
}

export default function useSurveySessions() {
  const [loaded] = useState(loadState);
  const [state, setState] = useState(loaded.state);
  const [storageError, setStorageError] = useState(loaded.error);
  const [storageBlocked, setStorageBlocked] = useState(loaded.blocked);
  const [persistedState, setPersistedState] = useState(
    loaded.blocked ? null : loaded.state
  );

  useEffect(() => {
    if (storageBlocked) return;
    try {
      const storage = globalThis.localStorage;
      const stored = storage?.getItem(STORAGE_KEY);
      const decoded = decodeSurveyStorage(stored);
      if (decoded.blocked) {
        setStorageError(decoded.error);
        setStorageBlocked(true);
        return;
      }
      const nextState =
        stored == null
          ? migrateSurveyState(state)
          : mergeSurveyStatesForPersistence(state, decoded.state);
      const serialized = JSON.stringify(nextState);
      storage?.setItem(STORAGE_KEY, serialized);
      if (serialized !== JSON.stringify(state)) {
        setState((current) => {
          const merged =
            stored == null
              ? migrateSurveyState(current)
              : mergeSurveyStatesForPersistence(current, decoded.state);
          return JSON.stringify(merged) === JSON.stringify(current)
            ? current
            : merged;
        });
      }
      setPersistedState(nextState);
      setStorageError(null);
    } catch (error) {
      setStorageError(
        `Survey history could not be saved; changes remain only in this tab. Export them before resetting storage: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }, [state, storageBlocked]);

  useEffect(() => {
    function handleStorage(event) {
      if (event.key !== STORAGE_KEY) return;
      if (event.newValue == null) {
        const empty = migrateSurveyState(null);
        setState(empty);
        setPersistedState(empty);
        setStorageError(null);
        setStorageBlocked(false);
        return;
      }
      const decoded = decodeSurveyStorage(event.newValue);
      if (decoded.blocked) {
        setStorageError(
          "Survey history changed in another tab but could not be read. The stored value was left untouched."
        );
        setStorageBlocked(true);
        return;
      }
      setState((current) => {
        const merged = mergeSurveyStates(current, decoded.state);
        return JSON.stringify(merged) === JSON.stringify(current)
          ? current
          : merged;
      });
      setStorageError(null);
      setStorageBlocked(false);
    }

    globalThis.addEventListener?.("storage", handleStorage);
    return () => globalThis.removeEventListener?.("storage", handleStorage);
  }, []);

  const resetStorage = useCallback(() => {
    try {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
      const empty = migrateSurveyState(null);
      setState(empty);
      setPersistedState(empty);
      setStorageError(null);
      setStorageBlocked(false);
    } catch (error) {
      setStorageError(
        `Survey history could not be reset: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }, []);

  const createSession = useCallback((name) => {
    const now = Date.now();
    const session = {
      id: makeId("session"),
      name: normalizeSurveySessionName(name),
      createdAt: now,
      updatedAt: now,
      nameUpdatedAt: now,
      measurements: [],
    };
    setState((current) => ({
      ...current,
      version: SURVEY_STORAGE_VERSION,
      sessions: [...current.sessions, session],
      activeSessionId: session.id,
      baselineSessionId:
        current.baselineSessionId === session.id
          ? null
          : current.baselineSessionId,
    }));
    return session.id;
  }, []);

  const setActiveSessionId = useCallback((sessionId) => {
    setState((current) => ({
      ...current,
      activeSessionId: sessionId,
      baselineSessionId:
        current.baselineSessionId === sessionId
          ? null
          : current.baselineSessionId,
    }));
  }, []);

  const setBaselineSessionId = useCallback((sessionId) => {
    setState((current) => ({
      ...current,
      baselineSessionId:
        sessionId && sessionId !== current.activeSessionId ? sessionId : null,
    }));
  }, []);

  const renameSession = useCallback((sessionId, name) => {
    const nextName = normalizeSurveySessionName(name);
    setState((current) => {
      const now = Date.now();
      let changed = false;
      const sessions = current.sessions.map((session) => {
        if (session.id !== sessionId || session.name === nextName) {
          return session;
        }
        changed = true;
        const previousNameUpdate = Number.isFinite(session.nameUpdatedAt)
          ? session.nameUpdatedAt
          : session.createdAt;
        const nameUpdatedAt = Math.max(now, previousNameUpdate + 1);
        return {
          ...session,
          name: nextName,
          nameUpdatedAt,
          updatedAt: Math.max(session.updatedAt, nameUpdatedAt),
        };
      });
      return changed ? { ...current, sessions } : current;
    });
  }, []);

  const addMeasurement = useCallback((sessionId, measurement) => {
    const now = Date.now();
    const saved = {
      ...measurement,
      id: makeId("measurement"),
      capturedAt: measurement.capturedAt ?? measurement.endedAt ?? now,
    };
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              updatedAt: now,
              measurements: [...session.measurements, saved],
            }
          : session
      ),
    }));
    return saved.id;
  }, []);

  const deleteMeasurement = useCallback((sessionId, measurementId) => {
    setState((current) => {
      const alreadyDeleted =
        current.deletedMeasurementIds.includes(measurementId);
      return {
        ...current,
        deletedMeasurementIds: alreadyDeleted
          ? current.deletedMeasurementIds
          : [...current.deletedMeasurementIds, measurementId],
        sessions: current.sessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                updatedAt: Date.now(),
                measurements: session.measurements.filter(
                  (measurement) => measurement.id !== measurementId
                ),
              }
            : session
        ),
      };
    });
  }, []);

  const deleteSession = useCallback((sessionId) => {
    setState((current) => {
      const sessions = current.sessions.filter(
        (session) => session.id !== sessionId
      );
      const activeSessionId =
        current.activeSessionId === sessionId
          ? sessions[0]?.id ?? null
          : current.activeSessionId;
      const alreadyDeleted = current.deletedSessionIds.includes(sessionId);
      return {
        ...current,
        sessions,
        activeSessionId,
        deletedSessionIds: alreadyDeleted
          ? current.deletedSessionIds
          : [...current.deletedSessionIds, sessionId],
        baselineSessionId:
          current.baselineSessionId === sessionId ||
          current.baselineSessionId === activeSessionId
            ? null
            : current.baselineSessionId,
      };
    });
  }, []);

  const activeSession = useMemo(
    () =>
      state.sessions.find(
        (session) => session.id === state.activeSessionId
      ) ?? null,
    [state.activeSessionId, state.sessions]
  );
  const baselineSession = useMemo(
    () =>
      state.sessions.find(
        (session) => session.id === state.baselineSessionId
      ) ?? null,
    [state.baselineSessionId, state.sessions]
  );
  const persistedMeasurementIds = useMemo(
    () =>
      new Set(
        (persistedState?.sessions ?? []).flatMap((session) =>
          session.measurements.map((measurement) => measurement.id)
        )
      ),
    [persistedState]
  );

  return {
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
    baselineSessionId: state.baselineSessionId,
    activeSession,
    baselineSession,
    storageError,
    storageBlocked,
    persistedMeasurementIds,
    resetStorage,
    createSession,
    setActiveSessionId,
    setBaselineSessionId,
    renameSession,
    addMeasurement,
    deleteMeasurement,
    deleteSession,
  };
}
