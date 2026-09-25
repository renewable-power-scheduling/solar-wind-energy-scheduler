import { useEffect, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Download,
  Info,
  Pencil,
  Plus,
  Save,
  X,
  RefreshCw,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { api } from '@/services/api';

const PLANT_OPTIONS = [
  { name: 'BHUPALPALLY', state: 'Telangana', type: 'Solar', capacityMw: 10, dcCapacityMw: 11.005, tilt: 5, azimuth: 180, latitude: 18.447931, longitude: 79.877263 },
  { name: 'KASIPET', state: 'Telangana', type: 'Solar', capacityMw: 15, latitude: 19.03943918, longitude: 79.43691745 },
  { name: 'KOTHAGUDEM', state: 'Telangana', type: 'Solar', capacityMw: 37, latitude: 17.52500925, longitude: 80.64616743 },
  { name: 'SIRMOUR', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 5.1 },
  { name: 'OSEPL', state: 'Maharashtra', type: 'Solar', capacityMw: 20, latitude: 17.9068, longitude: 76.3229 },
  { name: 'CME', state: 'Maharashtra', type: 'Solar', capacityMw: 5, latitude: 18.598528, longitude: 73.857808 },
  { name: 'CHANDWASA', state: 'Madhya Pradesh', type: 'Wind', capacityMw: 10 },
  { name: 'ZETRIC', state: 'Maharashtra', type: 'Solar', capacityMw: 25, latitude: 18.557968, longitude: 76.859083 },
  { name: 'JEWLI', state: 'Maharashtra', type: 'Wind', capacityMw: 100.8, latitude: 17.87562, longitude: 76.36388 },
  { name: 'JGBPL', state: 'Maharashtra', type: 'Wind', capacityMw: 50 },
  { name: 'SHAHA', state: 'Maharashtra', type: 'Solar', capacityMw: 25 },
  { name: 'SAWDA', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5 },
  { name: 'ANJANGAON', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5 },
  { name: 'ANDAD', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5, latitude: 21.95972222, longitude: 75.80583333 },
  { name: 'GUGARIYAKHEDI', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5, latitude: 21.83944444, longitude: 75.71888889 },
  { name: 'BALAKWADA', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5, latitude: 22.00583333, longitude: 75.52333333 },
  { name: 'NANDGAON', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 7.5, latitude: 21.88222222, longitude: 75.48027778 },
  { name: 'BAMKHAL', state: 'Madhya Pradesh', type: 'Solar', capacityMw: 5, latitude: 21.93, longitude: 75.671111 },
];
const STATE_OPTIONS = Array.from(new Set(PLANT_OPTIONS.map((plant) => plant.state)));

const VARIABLES = {
  Solar: ['GHI', 'DNI', 'DHI', 'GTI', 'Cloud Cover', 'Temperature'],
  Wind: ['Wind Speed', 'Wind Direction', 'Temperature', 'Pressure', 'Air Density'],
};

const MODEL_FAMILY_OPTIONS = [
  { label: 'ECMWF IFS 0.25 Ensemble', value: 'ecmwf_ifs025_ensemble' },
  { label: 'ECMWF AIFS 0.25 Ensemble', value: 'ecmwf_aifs025_ensemble' },
  { label: 'GFS Ensemble 0.25', value: 'gfs025' },
  { label: 'GFS Ensemble 0.5', value: 'gfs05' },
  { label: 'GFS Ensemble Seamless', value: 'gfs_seamless' },
  { label: 'AIGFS 0.25', value: 'aigfs025' },
  { label: 'GEM Global Ensemble', value: 'gem_global_ensemble' },
  { label: 'BOM ACCESS-GE', value: 'bom_access_global_ensemble' },
  { label: 'UKMO MOGREPS-G / Global 20km', value: 'ukmo_global_ensemble_20km' },
  { label: 'DWD ICON EPS Global', value: 'icon_global_eps' },
  { label: 'DWD ICON EPS Seamless', value: 'icon_seamless' },
  { label: 'Google WeatherNext 2 Ensemble', value: 'google_weathernext2_ensemble' },
];

const AGGREGATION_STRATEGY_OPTIONS = [
  { label: 'Top-6 Weighted Strategy', value: 'top6_weighted' },
  { label: 'Intellis Slot-wise Strategy', value: 'intellis_slotwise' },
  { label: 'Orion Best Recent Strategy', value: 'orion_best_recent' },
];

const MODEL_ROWS = [];
const MODEL_WEIGHTS = [];
const FORECAST_DATA = [];
const POWER_FORECAST = [];

const STATUS_ITEMS = ['Weather Data', 'Historical Data', 'Observation Data', 'Ranking Engine', 'Ensemble Engine'];
const chartLines = [
  ['ECMWF', '#2563eb'], ['ICON', '#0891b2'], ['GFS', '#f59e0b'], ['AIFS', '#8b5cf6'],
  ['UKMO', '#64748b'], ['ARPEGE', '#f97316'], ['Ensemble', '#059669'], ['Actual', '#111827'],
];

const finiteOrUndefined = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

function SelectField({ label, value, onChange, children, className = '' }) {
  return (
    <label className={`grid gap-1.5 text-sm ${className}`}>
      <span className="font-medium text-foreground">{label}</span>
      <span className="relative">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full appearance-none rounded-md border border-border bg-background px-3 pr-9 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
      </span>
    </label>
  );
}

function MetricCard({ icon: Icon, label, value, detail, tone = 'primary' }) {
  const toneClasses = {
    primary: 'bg-primary/10 text-primary',
    secondary: 'bg-secondary/10 text-secondary',
    'amber-500': 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    'emerald-600': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  };
  return (
    <Card className="gap-0 rounded-lg border-border shadow-none">
      <CardContent className="flex items-center gap-3 p-4">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${toneClasses[tone] || toneClasses.primary}`}>
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-medium text-muted-foreground">{label}</span>
          <span className="mt-1 block truncate text-lg font-semibold text-foreground">{value}</span>
          {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
        </span>
      </CardContent>
    </Card>
  );
}

function HealthRow({ label }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2.5 last:border-0 last:pb-0 first:pt-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Info className="h-3.5 w-3.5" /> Not connected
      </span>
    </div>
  );
}

function SectionHeading({ title, subtitle, action }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function WeatherModelIntelligence() {
  const [state, setState] = useState('Telangana');
  const [site, setSite] = useState('BHUPALPALLY');
  const [siteCatalog, setSiteCatalog] = useState(PLANT_OPTIONS);
  const [plantType, setPlantType] = useState('Solar');
  const [variableSelection, setVariableSelection] = useState('Yes');
  const [selectedVariables, setSelectedVariables] = useState(['GHI', 'GTI', 'Cloud Cover', 'Temperature']);
  const [horizon, setHorizon] = useState('+24 Hours');
  const [evaluationDays, setEvaluationDays] = useState('90');
  const [topModelCount, setTopModelCount] = useState('2');
  const [forecastDate, setForecastDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isVariableMenuOpen, setIsVariableMenuOpen] = useState(false);
  const [modelFamilySelected, setModelFamilySelected] = useState('ecmwf_aifs025_ensemble');
  const [isModelFamilyMenuOpen, setIsModelFamilyMenuOpen] = useState(false);
  const [aggregationStrategy, setAggregationStrategy] = useState('top6_weighted');
  const [isEditingSite, setIsEditingSite] = useState(false);
  const [isNewSite, setIsNewSite] = useState(false);
  const [isSavingSite, setIsSavingSite] = useState(false);
  const [siteMetadata, setSiteMetadata] = useState({ latitude: '', longitude: '', capacityMw: '', dcCapacityMw: '', tilt: '', azimuth: '' });
  const [siteNameDraft, setSiteNameDraft] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);

  const variableLabel = selectedVariables.join(', ') || 'No variable selected';
  const statePlants = siteCatalog.filter((plant) => plant.state === state);
  const selectedPlant = siteCatalog.find((plant) => plant.name === site) || statePlants[0] || siteCatalog[0] || PLANT_OPTIONS[0];
  const visibleSiteOptions = statePlants.map((plant) => plant.name);
  const evaluationPeriod = `Last ${evaluationDays || 0} Days`;
  const selectedModelLimit = Math.max(1, Number.parseInt(topModelCount, 10) || 1);
  const selectedModelFamilyLabel = MODEL_FAMILY_OPTIONS.find((item) => item.value === modelFamilySelected)?.label || 'Select model family';
  const subtitle = `${site} · ${variableLabel} · ${horizon} · ${evaluationPeriod} · ${forecastDate}`;
  const rankedModels = MODEL_ROWS.map((row, index) => ({ ...row, selected: index < selectedModelLimit }));
  const visibleModels = showAllModels ? rankedModels : rankedModels.slice(0, selectedModelLimit);

  useEffect(() => {
    let active = true;
    api.weatherModelIntelligence.listSites()
      .then((response) => {
        if (!active) return;
        const savedSites = Array.isArray(response?.sites) ? response.sites : [];
        if (!savedSites.length) return;
        setSiteCatalog((current) => {
          const merged = [...current];
          savedSites.forEach((saved) => {
            const index = merged.findIndex((plant) => plant.name === String(saved.site || '').trim().toUpperCase());
            const siteValue = {
              name: String(saved.site || '').trim().toUpperCase(),
              state: String(saved.state || '').trim(),
              type: String(saved.plant_type || '').trim() || 'Solar',
              capacityMw: finiteOrUndefined(saved.capacity_mw),
              dcCapacityMw: finiteOrUndefined(saved.dc_capacity_mw),
              tilt: finiteOrUndefined(saved.tilt),
              azimuth: finiteOrUndefined(saved.azimuth),
              latitude: finiteOrUndefined(saved.latitude),
              longitude: finiteOrUndefined(saved.longitude),
            };
            const cleanSiteValue = Object.fromEntries(Object.entries(siteValue).filter(([, value]) => value !== undefined));
            if (index >= 0) merged[index] = { ...merged[index], ...cleanSiteValue };
            else if (siteValue.name) merged.push(cleanSiteValue);
          });
          return merged;
        });
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (isEditingSite || !selectedPlant) return;
    setSiteMetadata({
      latitude: selectedPlant.latitude ?? '',
      longitude: selectedPlant.longitude ?? '',
      capacityMw: selectedPlant.capacityMw ?? '',
      dcCapacityMw: selectedPlant.dcCapacityMw ?? '',
      tilt: selectedPlant.tilt ?? '',
      azimuth: selectedPlant.azimuth ?? '',
    });
  }, [selectedPlant, isEditingSite]);

  const updatePlantType = (nextType) => {
    setPlantType(nextType);
    if (variableSelection === 'Yes') {
      setSelectedVariables([VARIABLES[nextType][0]]);
    } else if (variableSelection === 'No') {
      setSelectedVariables([]);
    }
    setIsVariableMenuOpen(false);
  };

  const updateVariableSelection = (nextSelection) => {
    setVariableSelection(nextSelection);
    setIsVariableMenuOpen(false);
    if (nextSelection === 'Yes' && selectedVariables.length === 0) {
      setSelectedVariables([VARIABLES[plantType][0]]);
    } else if (nextSelection === 'No') {
      setSelectedVariables([]);
    }
  };

  const updateSite = (nextSite) => {
    setSite(nextSite);
    const nextPlant = siteCatalog.find((plant) => plant.name === nextSite);
    if (nextPlant) updatePlantType(nextPlant.type);
  };

  const updateState = (nextState) => {
    setState(nextState);
    const nextPlant = siteCatalog.find((plant) => plant.state === nextState);
    if (nextPlant) {
      setSite(nextPlant.name);
      updatePlantType(nextPlant.type);
    }
  };

  const toggleVariable = (nextVariable) => {
    setSelectedVariables((current) => {
      if (current.includes(nextVariable)) {
        return current.length === 1 ? current : current.filter((item) => item !== nextVariable);
      }
      return [...current, nextVariable];
    });
  };

  const toggleModelFamily = (nextFamily) => {
    setModelFamilySelected(nextFamily);
    setIsModelFamilyMenuOpen(false);
  };

  const beginSiteEdit = () => {
    setIsNewSite(false);
    setIsEditingSite(true);
    setSiteNameDraft(site);
  };

  const beginNewSite = () => {
    setIsNewSite(true);
    setIsEditingSite(true);
    setSiteNameDraft('');
    setSiteMetadata({ latitude: '', longitude: '', capacityMw: '', dcCapacityMw: '', tilt: '', azimuth: '' });
    setPlantType('Solar');
  };

  const cancelSiteEdit = () => {
    setIsEditingSite(false);
    setIsNewSite(false);
    setSiteNameDraft(site);
    setSiteMetadata({
      latitude: selectedPlant?.latitude ?? '',
      longitude: selectedPlant?.longitude ?? '',
      capacityMw: selectedPlant?.capacityMw ?? '',
      dcCapacityMw: selectedPlant?.dcCapacityMw ?? '',
      tilt: selectedPlant?.tilt ?? '',
      azimuth: selectedPlant?.azimuth ?? '',
    });
  };

  const saveSiteMetadata = async () => {
    const siteName = String(isNewSite ? siteNameDraft : site).trim().toUpperCase();
    const latitude = Number(siteMetadata.latitude);
    const longitude = Number(siteMetadata.longitude);
    const capacityMw = Number(siteMetadata.capacityMw);
    const dcCapacityMw = Number(siteMetadata.dcCapacityMw);
    const tilt = Number(siteMetadata.tilt);
    const azimuth = Number(siteMetadata.azimuth);
    if (!siteName || !state || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(capacityMw) || capacityMw <= 0) {
      toast.error('Enter site, latitude, longitude, and a valid capacity');
      return;
    }
    setIsSavingSite(true);
    try {
      await api.weatherModelIntelligence.saveSite(siteName, {
        site: siteName,
        state,
        latitude,
        longitude,
        capacity_mw: capacityMw,
        dc_capacity_mw: Number.isFinite(dcCapacityMw) ? dcCapacityMw : null,
        tilt: Number.isFinite(tilt) ? tilt : null,
        azimuth: Number.isFinite(azimuth) ? azimuth : null,
        plant_type: plantType,
      });
      const savedPlant = {
        name: siteName,
        state,
        type: plantType,
        latitude,
        longitude,
        capacityMw,
        dcCapacityMw: Number.isFinite(dcCapacityMw) ? dcCapacityMw : '',
        tilt: Number.isFinite(tilt) ? tilt : '',
        azimuth: Number.isFinite(azimuth) ? azimuth : '',
      };
      setSiteCatalog((current) => {
        const index = current.findIndex((plant) => plant.name === siteName);
        if (index < 0) return [...current, savedPlant];
        return current.map((plant, itemIndex) => itemIndex === index ? { ...plant, ...savedPlant } : plant);
      });
      setSite(siteName);
      setIsEditingSite(false);
      setIsNewSite(false);
      toast.success('Site metadata saved');
    } catch (error) {
      toast.error(error?.message || 'Failed to save site metadata');
    } finally {
      setIsSavingSite(false);
    }
  };

  const demoAction = (message = 'Demo action — API integration will be connected later.') => toast.info(message);
  const applyFilters = async () => {
    setIsApplying(true);
    try {
      const dcCapacityMw = Number(siteMetadata.dcCapacityMw);
      const tilt = Number(siteMetadata.tilt);
      const azimuth = Number(siteMetadata.azimuth);
      await api.weatherModelIntelligence.save({
        site,
        forecast_date: forecastDate,
        plant_type: plantType,
        latitude: Number(siteMetadata.latitude) || null,
        longitude: Number(siteMetadata.longitude) || null,
        capacity_mw: Number(siteMetadata.capacityMw) || null,
        dc_capacity_mw: Number.isFinite(dcCapacityMw) ? dcCapacityMw : null,
        tilt: Number.isFinite(tilt) ? tilt : null,
        azimuth: Number.isFinite(azimuth) ? azimuth : null,
        model_families_selected: modelFamilySelected,
        top_models_to_select: Number.parseInt(topModelCount, 10) || 0,
        variables: variableSelection === 'Yes' ? selectedVariables : [],
        aggregation_strategy: aggregationStrategy,
        forecast_horizon: horizon,
      });
      toast.success('Weather intelligence context saved');
    } catch (error) {
      toast.error(error?.message || 'Failed to save weather intelligence filters');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto bg-background">
      <main className="mx-auto w-full max-w-[1680px] space-y-5 p-4 sm:p-6 lg:p-7">
        <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Sparkles className="h-5 w-5" />
              <span className="text-xs font-semibold uppercase tracking-[0.14em]">Forecast operations</span>
            </div>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Weather Model Intelligence</h1>
            <p className="mt-1 text-sm text-muted-foreground">Site-specific weather model evaluation, selection and ensemble forecasting</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Last Updated: <strong className="font-semibold text-foreground">Not available</strong></span>
            <Button variant="outline" size="icon" title="Refresh weather data" onClick={() => demoAction('Weather data refresh is unavailable until integration is connected.')}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <Card className="gap-0 rounded-lg border-border shadow-none">
          <CardHeader className="border-b border-border px-5 py-4">
            <CardTitle className="text-sm font-semibold">Forecast Controls</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-x-4 gap-y-4 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-12 xl:items-end">
            <SelectField className="xl:col-span-2" label="State" value={state} onChange={updateState}>
              {STATE_OPTIONS.map((item) => <option key={item}>{item}</option>)}
            </SelectField>
            <SelectField className="xl:col-span-2" label="Site" value={site} onChange={updateSite}>
              {visibleSiteOptions.map((item) => <option key={item}>{item}</option>)}
            </SelectField>
            <div className="flex items-end gap-2 xl:col-span-2">
              <Button type="button" variant="outline" className="h-10 flex-1" onClick={beginSiteEdit} disabled={isEditingSite}>
                <Pencil className="h-4 w-4" /> Edit site
              </Button>
              <Button type="button" variant="outline" size="icon" className="h-10 w-10" title="Add new site" onClick={beginNewSite} disabled={isEditingSite}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <SelectField className="xl:col-span-2" label="Plant Type" value={plantType} onChange={updatePlantType}>
              <option>Solar</option><option>Wind</option>
            </SelectField>
            {isNewSite && (
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium text-foreground">New Site Name</span>
                <input value={siteNameDraft} onChange={(event) => setSiteNameDraft(event.target.value.toUpperCase())} placeholder="SITE CODE" className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
              </label>
            )}
            <SelectField className="xl:col-span-2" label="Do you want to select variables?" value={variableSelection} onChange={updateVariableSelection}>
              <option value="">Select option</option>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
            </SelectField>
            {variableSelection === 'Yes' && (
              <div className="relative grid gap-1.5 text-sm xl:col-span-2">
                <span className="font-medium text-foreground">Variable</span>
                <button type="button" aria-haspopup="listbox" aria-expanded={isVariableMenuOpen} onClick={() => setIsVariableMenuOpen((current) => !current)} className="flex h-10 w-full items-center justify-between rounded-md border border-border bg-background px-3 text-left text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20">
                  <span className="truncate">{variableLabel || 'Select variable'}</span>
                  <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isVariableMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                {isVariableMenuOpen && (
                  <div role="listbox" aria-multiselectable="true" className="absolute left-0 right-0 top-[4.65rem] z-20 grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-border bg-background p-2.5 shadow-lg sm:grid-cols-3 xl:grid-cols-2">
                    {VARIABLES[plantType].map((item) => (
                      <label key={item} className="inline-flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-foreground hover:bg-muted/60">
                        <input type="checkbox" checked={selectedVariables.includes(item)} onChange={() => toggleVariable(item)} className="h-4 w-4 rounded border-border accent-primary" />
                        <span>{item}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="relative grid gap-1.5 text-sm xl:col-span-2">
              <span className="font-medium text-foreground">Model Families Selected</span>
              <button type="button" aria-haspopup="listbox" aria-expanded={isModelFamilyMenuOpen} onClick={() => setIsModelFamilyMenuOpen((current) => !current)} className="flex h-10 w-full items-center justify-between rounded-md border border-border bg-background px-3 text-left text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20">
                <span className="truncate">{selectedModelFamilyLabel}</span>
                <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isModelFamilyMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {isModelFamilyMenuOpen && (
                <div role="radiogroup" className="absolute left-0 right-0 top-[4.65rem] z-20 max-h-72 overflow-auto rounded-md border border-border bg-background p-2.5 shadow-lg">
                  {MODEL_FAMILY_OPTIONS.map((item) => (
                    <label key={item.value} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs text-foreground hover:bg-muted/60">
                      <input type="radio" name="weather-model-family" checked={modelFamilySelected === item.value} onChange={() => toggleModelFamily(item.value)} className="h-4 w-4 border-border accent-primary" />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <SelectField className="xl:col-span-2" label="Aggregation Strategy" value={aggregationStrategy} onChange={setAggregationStrategy}>
              {AGGREGATION_STRATEGY_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </SelectField>
            <SelectField className="xl:col-span-2" label="Forecast Horizon" value={horizon} onChange={setHorizon}>
              {['Now', '+6 Hours', '+12 Hours', '+24 Hours', '+48 Hours', '+72 Hours', '+7 Days'].map((item) => <option key={item}>{item}</option>)}
            </SelectField>
            <label className="grid gap-1.5 text-sm xl:col-span-2">
              <span className="font-medium text-foreground">Evaluation Period (days)</span>
              <input type="number" min="1" max="3650" step="1" value={evaluationDays} onChange={(event) => setEvaluationDays(event.target.value.replace(/[^0-9]/g, ''))} className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
            </label>
            <label className="grid gap-1.5 text-sm xl:col-span-2">
              <span className="font-medium text-foreground">Top Models to Select</span>
              <input type="number" min="1" max="12" step="1" value={topModelCount} onChange={(event) => setTopModelCount(event.target.value.replace(/[^0-9]/g, ''))} className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
            </label>
            <label className="grid gap-1.5 text-sm xl:col-span-2">
              <span className="font-medium text-foreground">Latitude</span>
              <input type="number" step="any" value={siteMetadata.latitude} readOnly={!isEditingSite} onChange={(event) => setSiteMetadata((current) => ({ ...current, latitude: event.target.value }))} className={`h-10 w-full rounded-md border border-border px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 ${isEditingSite ? 'bg-background' : 'bg-muted/30'}`} />
            </label>
            <label className="grid gap-1.5 text-sm xl:col-span-2">
              <span className="font-medium text-foreground">Longitude</span>
              <input type="number" step="any" value={siteMetadata.longitude} readOnly={!isEditingSite} onChange={(event) => setSiteMetadata((current) => ({ ...current, longitude: event.target.value }))} className={`h-10 w-full rounded-md border border-border px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 ${isEditingSite ? 'bg-background' : 'bg-muted/30'}`} />
            </label>
            <label className="grid gap-1.5 text-sm xl:col-span-2">
              <span className="font-medium text-foreground">Capacity (MW)</span>
              <input type="number" min="0" step="any" value={siteMetadata.capacityMw} readOnly={!isEditingSite} onChange={(event) => setSiteMetadata((current) => ({ ...current, capacityMw: event.target.value }))} className={`h-10 w-full rounded-md border border-border px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 ${isEditingSite ? 'bg-background' : 'bg-muted/30'}`} />
            </label>
            <label className="grid gap-1.5 text-sm xl:col-span-2">
              <span className="font-medium text-foreground">DC Capacity (MW)</span>
              <input type="number" min="0" step="any" value={siteMetadata.dcCapacityMw} readOnly={!isEditingSite} onChange={(event) => setSiteMetadata((current) => ({ ...current, dcCapacityMw: event.target.value }))} className={`h-10 w-full rounded-md border border-border px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 ${isEditingSite ? 'bg-background' : 'bg-muted/30'}`} />
            </label>
            <label className="grid gap-1.5 text-sm xl:col-span-2">
              <span className="font-medium text-foreground">Tilt</span>
              <input type="number" min="0" step="any" value={siteMetadata.tilt} readOnly={!isEditingSite} onChange={(event) => setSiteMetadata((current) => ({ ...current, tilt: event.target.value }))} className={`h-10 w-full rounded-md border border-border px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 ${isEditingSite ? 'bg-background' : 'bg-muted/30'}`} />
            </label>
            <label className="grid gap-1.5 text-sm xl:col-span-2">
              <span className="font-medium text-foreground">Azimuth</span>
              <input type="number" min="0" step="any" value={siteMetadata.azimuth} readOnly={!isEditingSite} onChange={(event) => setSiteMetadata((current) => ({ ...current, azimuth: event.target.value }))} className={`h-10 w-full rounded-md border border-border px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 ${isEditingSite ? 'bg-background' : 'bg-muted/30'}`} />
            </label>
            {isEditingSite && (
              <div className="flex items-end gap-2 xl:col-span-2">
                <Button type="button" className="h-10" onClick={saveSiteMetadata} disabled={isSavingSite}>
                  <Save className="h-4 w-4" /> {isSavingSite ? 'Saving...' : 'Save site'}
                </Button>
                <Button type="button" variant="outline" size="icon" className="h-10 w-10" title="Cancel site edit" onClick={cancelSiteEdit} disabled={isSavingSite}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
            <label className="grid gap-1.5 text-sm xl:col-span-2">
              <span className="font-medium text-foreground">Forecast Date</span>
              <span className="relative">
                <CalendarDays className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <input type="date" value={forecastDate} onChange={(event) => setForecastDate(event.target.value)} className="h-10 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
              </span>
            </label>
            <Button className="h-10 xl:col-span-2" onClick={applyFilters} disabled={isApplying}>
              {isApplying ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
              {isApplying ? 'Applying...' : 'Apply Filters'}
            </Button>
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard icon={Zap} label="Site Capacity" value={`${selectedPlant.capacityMw} MW`} detail={`${selectedPlant.name} · ${selectedPlant.type}`} />
          <MetricCard icon={Target} label="Location" value={selectedPlant.latitude && selectedPlant.longitude ? `${selectedPlant.latitude}° N, ${selectedPlant.longitude}° E` : 'Not available'} detail={selectedPlant.state} tone="secondary" />
          <MetricCard icon={BarChart3} label="Available Models" value="--" detail="Awaiting model data" tone="amber-500" />
          <MetricCard icon={Sparkles} label="Selected Models" value="--" detail="Awaiting ranking data" tone="emerald-600" />
        </div>

        <Card className="gap-0 rounded-lg border-border shadow-none">
          <SectionHeading title="System & Data Health" subtitle="Current readiness of the intelligence pipeline" />
          <CardContent className="grid gap-x-8 px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
            {STATUS_ITEMS.map((item) => <HealthRow key={item} label={item} />)}
          </CardContent>
        </Card>

        <Card className="gap-0 overflow-hidden rounded-lg border-border shadow-none">
          <SectionHeading
            title="Weather Model Performance"
            subtitle={`Historical performance for ${subtitle}`}
            action={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setShowAllModels((current) => !current)}>{showAllModels ? 'Show Top 6' : 'View All Models'}</Button><Button variant="outline" size="sm" onClick={() => demoAction('Ranking recalculation is unavailable until model data is connected.')}><RefreshCw className="h-3.5 w-3.5" /> Recalculate Ranking</Button></div>}
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground"><tr>{[['Rank'], ['Model'], ['Provider'], ['nMAE', 'Normalized Mean Absolute Error — lower values indicate lower forecast error.'], ['nRMSE', 'Root Mean Square Error — lower values indicate lower forecast error.'], ['Bias', 'Average forecast deviation from observed values.'], ['Correlation', 'Measures similarity between forecast and observed patterns.'], ['Score'], ['Selection']].map(([label, tip]) => <th key={label} className="px-5 py-3 font-semibold">{tip ? <span className="inline-flex items-center gap-1" title={tip}>{label}<Info className="h-3 w-3" /></span> : label}</th>)}</tr></thead>
              <tbody className="divide-y divide-border">
                {visibleModels.length ? visibleModels.map((row) => <tr key={row.model} className={row.selected ? 'bg-emerald-500/[0.035]' : 'hover:bg-muted/30'}><td className="px-5 py-3 text-muted-foreground">{row.rank}</td><td className="px-5 py-3 font-semibold text-foreground">{row.model}</td><td className="px-5 py-3 text-muted-foreground">{row.provider}</td><td className="px-5 py-3 text-foreground">{row.mae}</td><td className="px-5 py-3 text-foreground">{row.rmse}</td><td className="px-5 py-3 text-foreground">{row.bias}</td><td className="px-5 py-3 text-foreground">{row.correlation}</td><td className="px-5 py-3 font-semibold text-foreground">{row.score}</td><td className="px-5 py-3">{row.selected ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> Selected</span> : <span className="text-xs text-muted-foreground">Not Selected</span>}</td></tr>) : <tr><td colSpan={9} className="px-5 py-12 text-center text-sm text-muted-foreground">No model performance data available for this selection.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="gap-0 rounded-lg border-emerald-200 bg-emerald-500/[0.035] shadow-none dark:border-emerald-900/60">
          <SectionHeading title={`Selected Top ${selectedModelLimit} Models`} subtitle="Automatic model selection for the active context" />
          <CardContent className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-6">
            {MODEL_WEIGHTS.length ? MODEL_WEIGHTS.map(([model, weight]) => <div key={model} className="rounded-md border border-border bg-background px-3 py-3"><div className="text-sm font-semibold text-foreground">{model}</div><div className="mt-1 text-xs text-muted-foreground">Dynamic Weight</div><div className="mt-2 text-lg font-bold text-primary">{weight}%</div></div>) : <div className="rounded-md border border-dashed border-border px-4 py-5 text-sm text-muted-foreground sm:col-span-2 lg:col-span-6">Model weights will appear after ranking data is connected.</div>}
            <p className="text-xs leading-5 text-muted-foreground sm:col-span-2 lg:col-span-6">Weights are calculated from historical model performance for the selected site, variable and forecast horizon.</p>
          </CardContent>
        </Card>

        <Card className="gap-0 rounded-lg border-border shadow-none">
          <SectionHeading title="Forecast Comparison" subtitle="Selected models vs ensemble forecast" />
          <CardContent className="p-3 sm:p-5">
            <div className="h-[340px] w-full sm:h-[410px]">
              {FORECAST_DATA.length ? <ResponsiveContainer width="100%" height="100%"><LineChart data={FORECAST_DATA} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="time" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" /><YAxis domain={[35, 58]} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" unit=" MW" label={{ value: `${variableLabel} / forecast`, angle: -90, position: 'insideLeft', fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} /><Tooltip contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))' }} /><Legend wrapperStyle={{ fontSize: 11 }} />{chartLines.map(([key, color]) => <Line key={key} type="monotone" dataKey={key} stroke={color} strokeWidth={key === 'Ensemble' ? 3 : key === 'Actual' ? 2.5 : 1.5} strokeDasharray={key === 'Actual' ? '5 4' : undefined} dot={false} />)}</LineChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">No forecast comparison data available.</div>}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Forecast data will appear after the weather data source is connected.</p>
          </CardContent>
        </Card>

        <div className="grid gap-5 xl:grid-cols-[1.1fr_1.9fr]">
          <Card className="gap-0 rounded-lg border-border shadow-none">
            <SectionHeading title="Final Forecast Summary" subtitle="Ensemble output for the active context" />
            <CardContent className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-1">
              {[['Forecast Confidence', '--'], ['Ensemble Forecast', '--'], ['Model Agreement', '--'], ['Forecast Horizon', horizon]].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4 rounded-md border border-border bg-muted/20 px-3 py-3"><span className="text-sm text-muted-foreground">{label}</span><strong className="text-sm font-semibold text-foreground">{value}</strong></div>)}
              <div className="grid grid-cols-3 gap-2 border-t border-border pt-4 text-xs text-muted-foreground"><span>Bias Corrected<br /><strong className="text-foreground">--</strong></span><span>Models Used<br /><strong className="text-foreground">--</strong></span><span>Updated<br /><strong className="text-foreground">--</strong></span></div>
            </CardContent>
          </Card>

          <Card className="gap-0 overflow-hidden rounded-lg border-border shadow-none">
            <SectionHeading title={`${plantType === 'Wind' ? 'Wind' : 'Power'} Forecast`} subtitle="Forecast range" action={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => demoAction()}>View Forecast Details</Button><Button variant="outline" size="sm" onClick={() => demoAction('Demo export — CSV integration will be connected later.')}><Download className="h-3.5 w-3.5" /> Export CSV</Button></div>} />
            <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground"><tr>{['Time', 'Forecast', 'P10', 'P90'].map((label) => <th key={label} className="px-5 py-3 font-semibold">{label}</th>)}</tr></thead><tbody className="divide-y divide-border">{POWER_FORECAST.length ? POWER_FORECAST.map((row) => <tr key={row[0]} className="hover:bg-muted/30">{row.map((value) => <td key={value} className="px-5 py-3 text-foreground">{value}</td>)}</tr>) : <tr><td colSpan={4} className="px-5 py-12 text-center text-sm text-muted-foreground">No power forecast data available.</td></tr>}</tbody></table></div>
          </Card>
        </div>

        <Card className="gap-0 rounded-lg border-border shadow-none">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-end"><span className="mr-auto text-xs text-muted-foreground">All actions use static demo data until API integration is connected.</span><Button variant="outline" onClick={() => demoAction()}><RefreshCw className="h-4 w-4" /> Refresh Forecast</Button><Button variant="outline" onClick={() => demoAction('Demo export — CSV integration will be connected later.')}><Download className="h-4 w-4" /> Export CSV</Button><Button onClick={() => demoAction('Demo action — scheduling CSV generation will be connected later.')}><Zap className="h-4 w-4" /> Generate Scheduling CSV</Button></CardContent>
        </Card>
      </main>
    </div>
  );
}
