export function DeviationSummary() {
  return (
    <div className="border-2 border-black p-2 bg-white">
      <div className="mb-2">
        <span className="text-xs uppercase tracking-wider">DEVIATION & DSM RISK</span>
      </div>
      
      <div className="grid grid-cols-2 gap-2">
        <div className="border-2 border-black p-2 bg-gray-100">
          <div className="text-xs text-gray-600 mb-1 uppercase">Overall Deviation</div>
          <div className="text-xl text-center border-2 border-black bg-white py-1">---%</div>
        </div>

        <div className="border-2 border-black p-2 bg-gray-100">
          <div className="text-xs text-gray-600 mb-1 uppercase">DSM Risk Level</div>
          <div className="text-xl text-center border-2 border-black bg-white py-1">---</div>
        </div>
      </div>
    </div>
  );
}
