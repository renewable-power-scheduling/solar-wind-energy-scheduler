import { Filter, ChevronDown, Calendar, Clock, Plus, X } from 'lucide-react';
import { useState, useContext, useEffect } from 'react';
import { FilterContext } from '@/app/App';
import { PlantForm } from '@/app/components/ui/PlantForm';

export function FiltersSection() {
  const { filters: globalFilters, updateFilters } = useContext(FilterContext) || { filters: {}, updateFilters: () => {} };
  
  const [isStateOpen, setIsStateOpen] = useState(false);
  const [isPlantOpen, setIsPlantOpen] = useState(false);
  const [isTypeOpen, setIsTypeOpen] = useState(false);
  const [showPlantForm, setShowPlantForm] = useState(false);
  
  // Use global filters or fallback to local state
  const [localState, setLocalState] = useState({
    selectedState: globalFilters?.state || 'All States',
    selectedPlant: globalFilters?.plant || 'All Plants',
    selectedType: globalFilters?.type || 'Day-Ahead'
  });

  const states = ['All States', 'Maharashtra', 'Gujarat', 'Rajasthan', 'Tamil Nadu', 'Karnataka', 'Madhya Pradesh'];
  const types = ['Day-Ahead', 'Intraday', 'Real-Time'];

  // Update both local state and global filters
  const updateStateFilter = (value) => {
    setLocalState(prev => ({ ...prev, selectedState: value }));
    updateFilters?.({ state: value });
  };

  const updatePlantFilter = (value) => {
    setLocalState(prev => ({ ...prev, selectedPlant: value }));
    updateFilters?.({ plant: value });
  };

  const updateTypeFilter = (value) => {
    setLocalState(prev => ({ ...prev, selectedType: value }));
    updateFilters?.({ type: value });
  };

  // Get dynamic plants list from global context or use default
  const [availablePlants, setAvailablePlants] = useState([
    'All Plants', 
    'Wind Farm A', 
    'Solar Plant B', 
    'Wind Farm C', 
    'Solar Plant D',
    'Wind Farm E',
    'Solar Plant F'
  ]);

  // Close dropdowns when clicking outside
  const handleClickOutside = () => {
    setIsStateOpen(false);
    setIsPlantOpen(false);
    setIsTypeOpen(false);
  };

  // Handle plant added - update the available plants list
  const handlePlantAdded = (newPlant) => {
    // Add new plant to available plants list
    setAvailablePlants(prev => {
      const exists = prev.some(p => p === newPlant.name);
      if (exists) return prev;
      return [...prev, newPlant.name];
    });
    
    // Select the new plant
    updatePlantFilter(newPlant.name);
  };

  return (
    <div 
      className="bg-card rounded-lg border border-border shadow-sm p-4 animate-fade-in"
      onClick={handleClickOutside}
    >
      {showPlantForm && (
        <PlantForm 
          onClose={() => setShowPlantForm(false)} 
          onPlantAdded={handlePlantAdded}
        />
      )}
      
      <div className="flex items-center gap-2 mb-4">
        <Filter className="w-5 h-5 text-primary" />
        <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Filters</h3>
        {globalFilters?.plant && globalFilters.plant !== 'All Plants' && (
          <span className="ml-auto text-xs text-muted-foreground">
            Active: <span className="text-primary font-medium">{globalFilters.plant}</span>
          </span>
        )}
      </div>
      
      <div className="flex flex-wrap gap-3 items-end">
        {/* State Filter */}
        <div className="relative min-w-[150px]">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            State
          </label>
          <div 
            className="relative cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              setIsStateOpen(!isStateOpen);
              setIsPlantOpen(false);
              setIsTypeOpen(false);
            }}
          >
            <div className="w-full px-3 py-2.5 rounded-md border border-border bg-input-background text-sm text-foreground flex items-center justify-between hover:border-primary/50 transition-colors">
              <span>{localState.selectedState}</span>
              <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isStateOpen ? 'rotate-180' : ''}`} />
            </div>
            
            {isStateOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-md shadow-lg z-10 animate-scale-in">
                {states.map((state) => (
                  <button
                    key={state}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateStateFilter(state);
                      setIsStateOpen(false);
                    }}
                    className={`w-full px-3 py-2.5 text-left text-sm hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md ${
                      state === localState.selectedState ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'
                    }`}
                  >
                    {state}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Plant Filter */}
        <div className="relative min-w-[180px]">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block flex items-center gap-1">
            Plant
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowPlantForm(true);
              }}
              className="ml-1 p-0.5 rounded hover:bg-primary/10 text-primary transition-colors"
              title="Add new plant"
            >
              <Plus className="w-3 h-3" />
            </button>
          </label>
          <div 
            className="relative cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              setIsPlantOpen(!isPlantOpen);
              setIsStateOpen(false);
              setIsTypeOpen(false);
            }}
          >
            <div className="w-full px-3 py-2.5 rounded-md border border-border bg-input-background text-sm text-foreground flex items-center justify-between hover:border-primary/50 transition-colors">
              <span className="truncate">{localState.selectedPlant}</span>
              <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isPlantOpen ? 'rotate-180' : ''} flex-shrink-0`} />
            </div>
            
            {isPlantOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-md shadow-lg z-10 animate-scale-in max-h-60 overflow-auto">
                {availablePlants.map((plant) => (
                  <button
                    key={plant}
                    onClick={(e) => {
                      e.stopPropagation();
                      updatePlantFilter(plant);
                      setIsPlantOpen(false);
                    }}
                    className={`w-full px-3 py-2.5 text-left text-sm hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md flex items-center gap-2 ${
                      plant === localState.selectedPlant ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'
                    }`}
                  >
                    {plant.startsWith('Wind') && <span className="text-primary">🌬️</span>}
                    {plant.startsWith('Solar') && <span className="text-warning">☀️</span>}
                    {!plant.startsWith('Wind') && !plant.startsWith('Solar') && <span className="text-muted-foreground">📍</span>}
                    <span className="truncate">{plant}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Date Filter */}
        <div className="min-w-[150px]">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Date
          </label>
          <div className="relative">
            <input 
              type="date" 
              className="w-full px-3 py-2.5 rounded-md border border-border bg-input-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-all"
              value={globalFilters?.date || ''}
              onChange={(e) => updateFilters?.({ date: e.target.value })}
            />
            <Calendar className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          </div>
        </div>

        {/* Type Filter */}
        <div className="relative min-w-[140px]">
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Schedule Type
          </label>
          <div 
            className="relative cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              setIsTypeOpen(!isTypeOpen);
              setIsStateOpen(false);
              setIsPlantOpen(false);
            }}
          >
            <div className="w-full px-3 py-2.5 rounded-md border border-border bg-input-background text-sm text-foreground flex items-center justify-between hover:border-primary/50 transition-colors">
              <span>{localState.selectedType}</span>
              <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isTypeOpen ? 'rotate-180' : ''}`} />
            </div>
            
            {isTypeOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-md shadow-lg z-10 animate-scale-in">
                {types.map((type) => (
                  <button
                    key={type}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateTypeFilter(type);
                      setIsTypeOpen(false);
                    }}
                    className={`w-full px-3 py-2.5 text-left text-sm hover:bg-accent transition-colors first:rounded-t-md last:rounded-b-md ${
                      type === localState.selectedType ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Add New Plant Button */}
        <button
          onClick={() => setShowPlantForm(true)}
          className="px-4 py-2.5 rounded-md border border-border bg-muted/50 hover:bg-accent text-foreground font-medium text-sm transition-colors flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Add Plant
        </button>

        {/* Load Button */}
        <button className="px-6 py-2.5 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors flex items-center gap-2 shadow-sm hover:shadow-md">
          <Clock className="w-4 h-4" />
          Load Data
        </button>
      </div>
    </div>
  );
}

