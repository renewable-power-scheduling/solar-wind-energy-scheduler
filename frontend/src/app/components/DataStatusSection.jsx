export function DataStatusSection() {
  const dataItems = [
    { label: 'Forecast Data', status: 'Available' },
    { label: 'Meter Data', status: 'Available' },
    { label: 'WhatsApp Data', status: 'Pending' },
    { label: 'Weather Ref', status: 'View Only' },
  ];

  return (
    <div className="border-2 border-black p-2 bg-white h-full flex flex-col">
      <div className="mb-2">
        <span className="text-xs uppercase tracking-wider">DATA STATUS</span>
      </div>
      
      <div className="grid grid-cols-2 gap-2 flex-1">
        {dataItems.map((item, index) => (
          <div key={index} className="border-2 border-black p-2 bg-gray-100 flex flex-col justify-center">
            <div className="text-xs mb-1">{item.label}</div>
            <div className="text-xs border border-black px-1.5 py-0.5 bg-white inline-block">{item.status}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
