import Papa from "papaparse";
self.onmessage = (event: MessageEvent<{ text: string; delimiter?: string }>) => {
  const result = Papa.parse<string[]>(event.data.text, {
    delimiter: event.data.delimiter ?? "",
    skipEmptyLines: "greedy",
  });
  self.postMessage({
    rows: result.data,
    errors: result.errors
      .filter((e) => e.code !== "UndetectableDelimiter")
      .map((e) => ({ row: e.row, message: e.message })),
  });
};
