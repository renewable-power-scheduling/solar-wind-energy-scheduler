import { useState, useCallback, useEffect } from 'react';
import { ApiError } from '@/services/api';

/**
 * Custom hook for handling API calls with loading and error states
 * @param {Function} apiFunction - The API function to call
 * @param {Object} options - Configuration options
 * @returns {Object} - { data, loading, error, execute, reset }
 */
export function useApi(apiFunction, options = {}) {
  const {
    immediate = false,
    initialData = null,
    onSuccess = null,
    onError = null,
  } = options;

  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState(null);

  const execute = useCallback(
    async (...args) => {
      setLoading(true);
      setError(null);

      try {
        const result = await apiFunction(...args);
        setData(result);
        
        if (onSuccess) {
          onSuccess(result);
        }
        
        return { success: true, data: result };
      } catch (err) {
        const apiError = err instanceof ApiError ? err : new ApiError(err.message, 0);
        setError(apiError);
        
        if (onError) {
          onError(apiError);
        }
        
        return { success: false, error: apiError };
      } finally {
        setLoading(false);
      }
    },
    [apiFunction, onSuccess, onError]
  );

  const reset = useCallback(() => {
    setData(initialData);
    setLoading(false);
    setError(null);
  }, [initialData]);

  useEffect(() => {
    if (immediate) {
      execute();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [immediate]);

  return {
    data,
    loading,
    error,
    execute,
    reset,
  };
}

/**
 * Custom hook for handling multiple API calls
 * @param {Array} apiCalls - Array of API functions
 * @returns {Object} - { data, loading, errors, execute }
 */
export function useMultipleApi(apiCalls) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState([]);

  const execute = useCallback(async () => {
    setLoading(true);
    setErrors([]);

    try {
      const results = await Promise.allSettled(apiCalls.map(fn => fn()));
      
      const successData = results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
      
      const failedErrors = results
        .filter(r => r.status === 'rejected')
        .map(r => r.reason);

      setData(successData);
      setErrors(failedErrors);
      
      return { success: failedErrors.length === 0, data: successData, errors: failedErrors };
    } catch (err) {
      setErrors([err]);
      return { success: false, errors: [err] };
    } finally {
      setLoading(false);
    }
  }, [apiCalls]);

  return {
    data,
    loading,
    errors,
    execute,
  };
}

/**
 * Custom hook for pagination
 * @param {Function} apiFunction - The API function to call
 * @param {Object} options - Configuration options
 * @returns {Object} - { data, loading, error, page, totalPages, nextPage, prevPage, goToPage }
 */
export function usePaginatedApi(apiFunction, options = {}) {
  const { initialPage = 1, pageSize = 10 } = options;
  const [page, setPage] = useState(initialPage);
  const [totalPages, setTotalPages] = useState(1);

  const { data, loading, error, execute } = useApi(apiFunction, {
    onSuccess: (result) => {
      if (result.totalPages) {
        setTotalPages(result.totalPages);
      }
    },
  });

  const fetchPage = useCallback(
    (pageNum) => {
      setPage(pageNum);
      execute({ page: pageNum, pageSize });
    },
    [execute, pageSize]
  );

  const nextPage = useCallback(() => {
    if (page < totalPages) {
      fetchPage(page + 1);
    }
  }, [page, totalPages, fetchPage]);

  const prevPage = useCallback(() => {
    if (page > 1) {
      fetchPage(page - 1);
    }
  }, [page, fetchPage]);

  const goToPage = useCallback(
    (pageNum) => {
      if (pageNum >= 1 && pageNum <= totalPages) {
        fetchPage(pageNum);
      }
    },
    [totalPages, fetchPage]
  );

  useEffect(() => {
    fetchPage(initialPage);
  }, []);

  return {
    data,
    loading,
    error,
    page,
    totalPages,
    nextPage,
    prevPage,
    goToPage,
  };
}