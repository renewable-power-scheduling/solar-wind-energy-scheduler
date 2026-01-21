
import { useState } from 'react';
import { X, Wind, Sun, MapPin, Zap, AlertCircle } from 'lucide-react';
import { api } from '@/services/api';

export function PlantForm({ onClose, onPlantAdded }) {
  const [formData, setFormData] = useState({
    name: '',
    type: 'Wind',
    capacity: '',
    state: '',
    status: 'Active',
    efficiency: '',
    latitude: '',
    longitude: '',
    location_name: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const states = ['Maharashtra', 'Gujarat', 'Rajasthan', 'Tamil Nadu', 'Karnataka', 'Madhya Pradesh', 'Telangana', 'Uttar Pradesh'];

  // State coordinates for auto-fill
  const stateCoordinates = {
    'Maharashtra': { lat: 19.0760, lng: 72.8777 },
    'Gujarat': { lat: 22.2587, lng: 71.1924 },
    'Rajasthan': { lat: 27.0238, lng: 74.2179 },
    'Tamil Nadu': { lat: 11.1271, lng: 78.6569 },
    'Karnataka': { lat: 15.3173, lng: 75.7139 },
    'Madhya Pradesh': { lat: 22.9734, lng: 78.6569 },
    'Telangana': { lat: 17.1231, lng: 77.3508 },
    'Uttar Pradesh': { lat: 26.8467, lng: 80.9462 }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleStateChange = (state) => {
    setFormData(prev => {
      const newData = { ...prev, state };
      // Auto-fill coordinates based on state
      if (stateCoordinates[state]) {
        newData.latitude = stateCoordinates[state].lat.toFixed(4);
        newData.longitude = stateCoordinates[state].lng.toFixed(4);
      }
      return newData;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Create plant via API
      const plantPayload = {
        name: formData.name,
        type: formData.type,
        capacity: parseFloat(formData.capacity),
        state: formData.state,
        status: formData.status,
        efficiency: parseFloat(formData.efficiency) || 0,
        latitude: formData.latitude ? parseFloat(formData.latitude) : null,
        longitude: formData.longitude ? parseFloat(formData.longitude) : null,
        location_name: formData.location_name || null
      };

      const response = await api.plants.create(plantPayload);
      
      // Call callback to refresh plants list
      if (onPlantAdded) {
        await onPlantAdded(response.plant || response);
      }

      onClose();
    } catch (err) {
      setError(err.message || 'Failed to create plant. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl border border-slate-700 max-h-[90vh] overflow-hidden relative">
        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900" />
        <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
        
        {/* Header */}
        <div className="relative px-6 py-5 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/50 to-transparent flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                formData.type === 'Wind' 
                  ? 'bg-gradient-to-br from-blue-600 to-cyan-600' 
                  : 'bg-gradient-to-br from-amber-600 to-orange-600'
              }`}>
                {formData.type === 'Wind' ? (
                  <Wind className="w-6 h-6 text-white" />
                ) : (
                  <Sun className="w-6 h-6 text-white" />
                )}
              </div>
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Add New Plant</h2>
              <p className="text-sm text-slate-400 mt-1">Register a new renewable energy plant</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 rounded-xl bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700/50 hover:border-slate-600 transition-all"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="relative p-6 space-y-6 overflow-auto max-h-[calc(90vh-140px)] scrollbar-thin">
          {error && (
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Plant Type Selection */}
          <div>
            <label className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-3 block">Plant Type *</label>
            <div className="grid grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setFormData(prev => ({ ...prev, type: 'Wind', name: prev.name.replace('Solar', 'Wind') }))}
                className={`group relative p-5 rounded-xl border-2 transition-all duration-300 overflow-hidden ${
                  formData.type === 'Wind' 
                    ? 'border-blue-500/50 bg-gradient-to-br from-blue-500/20 to-cyan-500/10' 
                    : 'border-slate-700/50 bg-slate-800/30 hover:border-slate-600'
                }`}
              >
                <div className={`absolute inset-0 bg-gradient-to-r from-blue-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300`} />
                <Wind className={`w-10 h-10 mb-3 relative z-10 ${
                  formData.type === 'Wind' ? 'text-blue-400' : 'text-slate-500 group-hover:text-slate-400'
                }`} />
                <p className={`font-semibold relative z-10 ${formData.type === 'Wind' ? 'text-white' : 'text-slate-300'}`}>Wind Farm</p>
                <p className="text-xs text-slate-500 mt-1 relative z-10">Wind turbine generators</p>
              </button>
              <button
                type="button"
                onClick={() => setFormData(prev => ({ ...prev, type: 'Solar', name: prev.name.replace('Wind', 'Solar') }))}
                className={`group relative p-5 rounded-xl border-2 transition-all duration-300 overflow-hidden ${
                  formData.type === 'Solar' 
                    ? 'border-amber-500/50 bg-gradient-to-br from-amber-500/20 to-orange-500/10' 
                    : 'border-slate-700/50 bg-slate-800/30 hover:border-slate-600'
                }`}
              >
                <div className={`absolute inset-0 bg-gradient-to-r from-amber-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300`} />
                <Sun className={`w-10 h-10 mb-3 relative z-10 ${
                  formData.type === 'Solar' ? 'text-amber-400' : 'text-slate-500 group-hover:text-slate-400'
                }`} />
                <p className={`font-semibold relative z-10 ${formData.type === 'Solar' ? 'text-white' : 'text-slate-300'}`}>Solar Plant</p>
                <p className="text-xs text-slate-500 mt-1 relative z-10">Photovoltaic panels</p>
              </button>
            </div>
          </div>

          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2 block">Plant Name *</label>
              <input
                type="text"
                name="name"
                value={formData.name}
                onChange={handleChange}
                placeholder={formData.type === 'Wind' ? 'Wind Farm X' : 'Solar Plant Y'}
                required
                className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all hover:bg-slate-800"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2 block">Capacity (MW) *</label>
              <div className="relative">
                <Zap className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-400" />
                <input
                  type="number"
                  name="capacity"
                  value={formData.capacity}
                  onChange={handleChange}
                  placeholder="100"
                  min="0"
                  step="0.1"
                  required
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all hover:bg-slate-800"
                />
              </div>
            </div>
          </div>

          {/* Location */}
          <div>
            <label className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2 block">State *</label>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-400" />
              <select
                name="state"
                value={formData.state}
                onChange={(e) => handleStateChange(e.target.value)}
                required
                className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all hover:bg-slate-800 appearance-none cursor-pointer"
              >
                <option value="" className="bg-slate-900">Select State</option>
                {states.map(state => (
                  <option key={state} value={state} className="bg-slate-900">{state}</option>
                ))}
              </select>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          </div>

          {/* Location Name */}
          <div>
            <label className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2 block">Location Name (Optional)</label>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                name="location_name"
                value={formData.location_name}
                onChange={handleChange}
                placeholder="e.g., Bhimagad Wind Farm, Nakhatarni"
                className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all hover:bg-slate-800"
              />
            </div>
          </div>

          {/* Coordinates */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2 block">Latitude</label>
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cyan-400" />
                <input
                  type="number"
                  name="latitude"
                  value={formData.latitude}
                  onChange={handleChange}
                  placeholder="19.0760"
                  min="-90"
                  max="90"
                  step="0.0001"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all hover:bg-slate-800"
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2 block">Longitude</label>
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-purple-400" />
                <input
                  type="number"
                  name="longitude"
                  value={formData.longitude}
                  onChange={handleChange}
                  placeholder="72.8777"
                  min="-180"
                  max="180"
                  step="0.0001"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all hover:bg-slate-800"
                />
              </div>
            </div>
          </div>

          {/* Additional Details */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2 block">Efficiency (%)</label>
              <div className="relative">
                <Zap className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-purple-400" />
                <input
                  type="number"
                  name="efficiency"
                  value={formData.efficiency}
                  onChange={handleChange}
                  placeholder="95"
                  min="0"
                  max="100"
                  step="0.1"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all hover:bg-slate-800"
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-2 block">Status</label>
              <div className="relative">
                <select
                  name="status"
                  value={formData.status}
                  onChange={handleChange}
                  className="w-full px-4 py-3 rounded-xl bg-slate-800/50 border border-slate-700/50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all hover:bg-slate-800 appearance-none cursor-pointer"
                >
                  <option value="Active" className="bg-slate-900">Active</option>
                  <option value="Maintenance" className="bg-slate-900">Maintenance</option>
                  <option value="Inactive" className="bg-slate-900">Inactive</option>
                </select>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                  <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>
            </div>
          </div>

          {/* Map Preview */}
          {formData.latitude && formData.longitude && (
            <div className="relative overflow-hidden rounded-2xl bg-slate-800/30 border border-slate-700/50">
              <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/5 to-transparent" />
              <div className="relative p-4">
                <h4 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-indigo-400" />
                  Location Preview
                </h4>
                <div className="h-40 rounded-xl overflow-hidden">
                  <iframe
                    width="100%"
                    height="100%"
                    frameBorder="0"
                    scrolling="no"
                    marginHeight="0"
                    marginWidth="0"
                    src={`https://maps.google.com/maps?q=${formData.latitude},${formData.longitude}&t=&z=10&ie=UTF8&iwloc=&output=embed`}
                    title="Plant Location"
                  />
                </div>
                <p className="text-xs text-slate-400 mt-2">
                  {formData.location_name || `${formData.latitude}, ${formData.longitude}`}
                </p>
              </div>
            </div>
          )}

          {/* Summary */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-800/50 to-slate-900/50 border border-slate-700/50">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-indigo-500/10 to-transparent rounded-full blur-2xl" />
            <div className="relative p-5">
              <h4 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-400" />
                Plant Summary
              </h4>
              <div className="grid grid-cols-3 gap-4">
                <div className="p-3 rounded-xl bg-slate-800/50 border border-slate-700/50">
                  <p className="text-xs text-slate-400 uppercase tracking-wider">Type</p>
                  <p className="font-semibold text-white mt-1 flex items-center gap-2">
                    {formData.type === 'Wind' ? (
                      <Wind className="w-4 h-4 text-blue-400" />
                    ) : (
                      <Sun className="w-4 h-4 text-amber-400" />
                    )}
                    {formData.type || '-'}
                  </p>
                </div>
                <div className="p-3 rounded-xl bg-slate-800/50 border border-slate-700/50">
                  <p className="text-xs text-slate-400 uppercase tracking-wider">Capacity</p>
                  <p className="font-semibold text-white mt-1">{formData.capacity ? `${formData.capacity} MW` : '-'}</p>
                </div>
                <div className="p-3 rounded-xl bg-slate-800/50 border border-slate-700/50">
                  <p className="text-xs text-slate-400 uppercase tracking-wider">Location</p>
                  <p className="font-semibold text-white mt-1 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-emerald-400" />
                    {formData.state || '-'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t border-slate-700/50">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3.5 rounded-xl bg-slate-800/50 border border-slate-700/50 text-slate-300 hover:text-white hover:bg-slate-700/50 hover:border-slate-600 transition-all duration-300 font-semibold"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !formData.name || !formData.capacity || !formData.state}
              className={`flex-1 px-4 py-3.5 rounded-xl font-semibold transition-all duration-300 flex items-center justify-center gap-2 ${
                formData.type === 'Wind'
                  ? 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white shadow-lg shadow-blue-500/25'
                  : 'bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white shadow-lg shadow-amber-500/25'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  {formData.type === 'Wind' ? (
                    <Wind className="w-4 h-4" />
                  ) : (
                    <Sun className="w-4 h-4" />
                  )}
                  Create Plant
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

