export default function TogglePanel() {
    return (
      <div className="bg-white border rounded-xl p-4 shadow-sm">
        <h3 className="font-semibold mb-3">Data Streams</h3>
  
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label><input type="checkbox" defaultChecked /> Day-Ahead</label>
          <label><input type="checkbox" /> Intraday</label>
          <label><input type="checkbox" defaultChecked /> Actual</label>
          <label><input type="checkbox" /> Capacity</label>
        </div>
      </div>
    );
  }
  