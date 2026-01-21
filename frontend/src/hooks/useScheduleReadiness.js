import { useState, useEffect, useCallback } from 'react';
import { scheduleReadinessApi } from '@/services/api';

/**
 * Custom hook for schedule readiness functionality
 */
export function useScheduleReadiness(options = {}) {
  const { autoRefresh = false, refreshInterval = 60000 } = options;

  const [readiness, setReadiness] = useState({
    data: null,
    loading: true,
    error: null
  });

  const [summary, setSummary] = useState({
    total: 0,
    ready: 0,
    pending: 0,
    no_action: 0
  });

  const [notifications, setNotifications] = useState({
    data: [],
    unreadCount: 0,
    loading: false
  });

  const [actionLoading, setActionLoading] = useState({
    trigger: false,
    continue: false,
    markReady: false,
    checkTriggers: false
  });

  // Fetch all readiness data
  const fetchReadiness = useCallback(async (statusFilter = null) => {
    setReadiness(prev => ({ ...prev, loading: true, error: null }));
    try {
      const data = await scheduleReadinessApi.getAll(statusFilter);
      setReadiness({ data, loading: false, error: null });
      return data;
    } catch (error) {
      setReadiness(prev => ({ ...prev, loading: false, error: error.message }));
      return null;
    }
  }, []);

  // Fetch summary only
  const fetchSummary = useCallback(async () => {
    try {
      const data = await scheduleReadinessApi.getSummary();
      setSummary(data);
    } catch (error) {
      console.error('Error fetching summary:', error);
    }
  }, []);

  // Fetch notifications
  const fetchNotifications = useCallback(async (unreadOnly = false) => {
    setNotifications(prev => ({ ...prev, loading: true }));
    try {
      const data = await scheduleReadinessApi.getNotifications(unreadOnly);
      setNotifications({
        data: data.notifications || [],
        unreadCount: data.unread_count || 0,
        loading: false
      });
    } catch (error) {
      setNotifications(prev => ({ ...prev, loading: false }));
      console.error('Error fetching notifications:', error);
    }
  }, []);

  // Trigger manual revision
  const triggerRevision = useCallback(async (plantId, reason) => {
    setActionLoading(prev => ({ ...prev, trigger: true }));
    try {
      const result = await scheduleReadinessApi.triggerRevision(plantId, reason);
      // Refresh data after action
      await fetchReadiness();
      await fetchSummary();
      return result;
    } catch (error) {
      console.error('Error triggering revision:', error);
      throw error;
    } finally {
      setActionLoading(prev => ({ ...prev, trigger: false }));
    }
  }, [fetchReadiness, fetchSummary]);

  // Continue existing schedule
  const continueExisting = useCallback(async (plantId) => {
    setActionLoading(prev => ({ ...prev, continue: true }));
    try {
      const result = await scheduleReadinessApi.continueExisting(plantId);
      // Refresh data after action
      await fetchReadiness();
      await fetchSummary();
      return result;
    } catch (error) {
      console.error('Error continuing schedule:', error);
      throw error;
    } finally {
      setActionLoading(prev => ({ ...prev, continue: false }));
    }
  }, [fetchReadiness, fetchSummary]);

  // Mark schedule as ready
  const markScheduleReady = useCallback(async (plantId, uploadDeadline) => {
    setActionLoading(prev => ({ ...prev, markReady: true }));
    try {
      const result = await scheduleReadinessApi.markReady(plantId, uploadDeadline);
      // Refresh data after action
      await fetchReadiness();
      await fetchSummary();
      await fetchNotifications();
      return result;
    } catch (error) {
      console.error('Error marking ready:', error);
      throw error;
    } finally {
      setActionLoading(prev => ({ ...prev, markReady: false }));
    }
  }, [fetchReadiness, fetchSummary, fetchNotifications]);

  // Check triggers for all plants
  const checkTriggers = useCallback(async () => {
    setActionLoading(prev => ({ ...prev, checkTriggers: true }));
    try {
      const result = await scheduleReadinessApi.checkTriggers();
      // Refresh data after check
      await fetchReadiness();
      await fetchSummary();
      return result;
    } catch (error) {
      console.error('Error checking triggers:', error);
      throw error;
    } finally {
      setActionLoading(prev => ({ ...prev, checkTriggers: false }));
    }
  }, [fetchReadiness, fetchSummary]);

  // Mark notification as read
  const markNotificationRead = useCallback(async (notificationId) => {
    try {
      await scheduleReadinessApi.markNotificationRead(notificationId);
      // Refresh notifications
      await fetchNotifications();
    } catch (error) {
      console.error('Error marking notification read:', error);
      throw error;
    }
  }, [fetchNotifications]);

  // Initial fetch
  useEffect(() => {
    fetchReadiness();
    fetchSummary();
    fetchNotifications();
  }, [fetchReadiness, fetchSummary, fetchNotifications]);

  // Auto-refresh if enabled
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      fetchReadiness();
      fetchSummary();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, fetchReadiness, fetchSummary]);

  return {
    // Data
    readiness: readiness.data,
    readinessLoading: readiness.loading,
    readinessError: readiness.error,
    summary,
    notifications: notifications.data,
    unreadNotificationCount: notifications.unreadCount,
    notificationsLoading: notifications.loading,
    
    // Actions
    fetchReadiness,
    fetchSummary,
    fetchNotifications,
    triggerRevision,
    continueExisting,
    markScheduleReady,
    checkTriggers,
    markNotificationRead,
    
    // Loading states
    actionLoading
  };
}


/**
 * Get status badge configuration
 */
export function getStatusConfig(status) {
  const config = {
    READY: {
      color: 'bg-success/10 text-success border-success/20',
      icon: 'check-circle',
      iconColor: 'text-success',
      label: 'Ready',
      description: 'Schedule ready for upload'
    },
    PENDING: {
      color: 'bg-warning/10 text-warning border-warning/20',
      icon: 'clock',
      iconColor: 'text-warning',
      label: 'Pending',
      description: 'Action required'
    },
    NO_ACTION: {
      color: 'bg-muted/10 text-muted-foreground border-muted/20',
      icon: 'minus-circle',
      iconColor: 'text-muted-foreground',
      label: 'No Action',
      description: 'Continuing existing schedule'
    }
  };

  return config[status] || config.NO_ACTION;
}


/**
 * Get priority configuration for notifications
 */
export function getPriorityConfig(priority) {
  const config = {
    URGENT: {
      color: 'bg-destructive/10 text-destructive border-destructive/20',
      icon: 'alert-circle'
    },
    HIGH: {
      color: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
      icon: 'alert-triangle'
    },
    NORMAL: {
      color: 'bg-primary/10 text-primary border-primary/20',
      icon: 'info'
    },
    LOW: {
      color: 'bg-muted/10 text-muted-foreground border-muted/20',
      icon: 'bell'
    }
  };

  return config[priority] || config.NORMAL;
}

