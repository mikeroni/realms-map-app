/** Pure data rules. No Google services; exercised by node --test. */
const RealmData = (() => {
  const masterHeader = ['World', 'Location', 'X', 'Z', 'Type', 'Owner'];
  const mapHeader = ['Origin/Destination', 'Path', 'Location', 'X', 'Z', 'Type', 'Owner'];
  const worlds = {Overworld: 'Tableau Data', Nether: 'Nether Data', End: 'End Data'};

  function text(value) {
    return value == null ? '' : String(value).trim();
  }

  function field(value, label, required = true) {
    const result = text(value);
    if ((required && !result) || result.length > 200 || /[\x00-\x1f]/.test(result)
        || result.startsWith('=')) {
      throw new Error(label + ' must be plain text, up to 200 characters.');
    }
    return result;
  }

  function coordinate(value) {
    if (typeof value === 'boolean' || text(value) === '' || !Number.isSafeInteger(Number(value))) {
      throw new Error('X and Z must be whole block coordinates, including zero or negative values.');
    }
    return Number(value);
  }

  function table(values, header, name) {
    if (!Array.isArray(values) || JSON.stringify(values[0]) !== JSON.stringify(header)) {
      throw new Error(name + ': expected the original column headings in their original order.');
    }
    return values.slice(1).filter(row => row.some(value => text(value) !== ''));
  }

  function location(row) {
    const world = field(row[0], 'World');
    if (!Object.prototype.hasOwnProperty.call(worlds, world)) throw new Error('Choose Overworld, Nether, or End.');
    return {
      world, name: field(row[1], 'Location'), x: coordinate(row[2]), z: coordinate(row[3]),
      type: field(row[4], 'Type', false), owner: field(row[5], 'Owner', false),
    };
  }

  function key(place) { return place.world + '\u0000' + place.name.toLowerCase(); }
  function pair(a, b) { return [a, b].sort().join('\u0000'); }
  function same(a, b) {
    return a.name === b.name && a.x === b.x && a.z === b.z
      && a.type === b.type && a.owner === b.owner;
  }
  function mapRow(place, path = '', role = 'Origin') {
    return [role, path, place.name, place.x, place.z, place.type, place.owner];
  }

  function validateMap(values, world) {
    const rows = table(values, mapHeader, worlds[world]).map(row => {
      if (row.length !== 7) throw new Error('Map rows must have seven columns.');
      const place = location([world, ...row.slice(2)]);
      return mapRow(place, field(row[1], 'Path', false), field(row[0], 'Origin/Destination'));
    });
    const places = new Map();
    const paths = new Map();
    for (const row of rows) {
      if (!['Origin', 'Destination'].includes(row[0])) throw new Error('Invalid endpoint role.');
      const place = location([world, ...row.slice(2)]);
      const previous = places.get(key(place));
      if (previous && !same(previous, place)) throw new Error('Conflicting data for ' + place.name);
      places.set(key(place), place);
      if (row[1]) {
        if (row[1].includes(',')) throw new Error('Path names cannot contain commas (Tableau filter delimiter).');
        if (!paths.has(row[1])) paths.set(row[1], []);
        paths.get(row[1]).push(row);
      }
    }
    const pairs = new Set();
    for (const [name, endpoints] of paths) {
      if (endpoints.length !== 2 || endpoints[0][2] === endpoints[1][2]
          || endpoints.filter(row => row[0] === 'Origin').length !== 1
          || endpoints.filter(row => row[0] === 'Destination').length !== 1) {
        throw new Error('Path ' + name + ' needs one Origin and one distinct Destination.');
      }
      const id = pair(endpoints[0][2], endpoints[1][2]);
      if (pairs.has(id)) throw new Error('Duplicate connection: ' + name);
      pairs.add(id);
    }
    return {rows, places, paths, pairs};
  }

  function model(master, maps) {
    const places = new Map();
    const warnings = [];
    for (const row of table(master, masterHeader, 'Master Locations')) {
      if (row.length !== 6) throw new Error('Master rows must have six columns.');
      const place = location(row);
      if (places.has(key(place))) throw new Error('Duplicate master location: ' + place.name);
      places.set(key(place), place);
    }
    const networks = {};
    for (const world of Object.keys(worlds)) {
      networks[world] = validateMap(maps[world], world);
      for (const [id, place] of networks[world].places) {
        if (places.has(id) && !same(places.get(id), place)) {
          throw new Error('Master/map mismatch for ' + world + ': ' + place.name + '. Resolve it before editing.');
        }
        if (!places.has(id)) {
          warnings.push(place.name + ' (' + world + ') is mapped but missing from Master Locations; it is preserved.');
          places.set(id, place);
        }
      }
    }
    return {places, networks, warnings};
  }

  function planLocation(master, maps, input) {
    const data = model(master, maps);
    const place = location([input.world, input.name, input.x, input.z, input.type, input.owner]);
    const previous = data.places.get(key(place));
    if (previous && !same(previous, place)) throw new Error('That location already exists with different details.');
    const inMaster = table(master, masterHeader, 'Master Locations')
      .some(row => key(location(row)) === key(place));
    return {
      world: place.world, name: place.name,
      masterRows: inMaster ? [] : [[place.world, place.name, place.x, place.z, place.type, place.owner]],
      mapRows: input.showOnMap === true && !data.networks[place.world].places.has(key(place))
        ? [mapRow(place)] : [],
    };
  }

  function planConnections(master, maps, input) {
    const data = model(master, maps);
    if (input.world !== 'Overworld') throw new Error('This editor adds Overworld rail connections only.');
    const source = data.places.get(key({world: input.world, name: field(input.source, 'Source')}));
    if (!source) throw new Error('Source location no longer exists. Reload the sidebar.');
    if (!Array.isArray(input.destinations) || input.destinations.length > 200) {
      throw new Error('Choose up to 200 destinations.');
    }
    const network = data.networks.Overworld;
    const names = new Set(network.paths.keys());
    const pairs = new Set(network.pairs);
    const rows = [];
    const added = [];
    for (const name of input.destinations) {
      const target = data.places.get(key({world: 'Overworld', name: field(name, 'Destination')}));
      if (!target) throw new Error('Destination no longer exists: ' + name);
      if (target.name === source.name) throw new Error('A location cannot connect to itself.');
      const id = pair(source.name, target.name);
      if (pairs.has(id)) continue; // Repeated saves and reversed pairs are harmless.
      if (source.name.includes(',') || target.name.includes(',')) {
        throw new Error('Rail endpoint names cannot contain commas (Tableau filter delimiter).');
      }
      const base = source.name + ' to ' + target.name;
      let path = base;
      let suffix = 2;
      while (names.has(path)) path = base + ' (' + suffix++ + ')';
      field(path, 'Generated path');
      names.add(path);
      pairs.add(id);
      rows.push(mapRow(source, path), mapRow(target, path, 'Destination'));
      added.push(path);
    }
    return {rows, added};
  }

  // Hash coordinates as decimal strings, avoiding JSON number-format differences across runtimes.
  function canonical(values) {
    const checked = validateMap(values, 'Overworld');
    if (!checked.rows.length) throw new Error('Cannot publish an empty map.');
    const rows = checked.rows.map(row => row.map(String));
    rows.sort((a, b) => {
      const left = JSON.stringify(a), right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return JSON.stringify([mapHeader, ...rows]);
  }

  return {masterHeader, mapHeader, worlds, model, planLocation, planConnections, canonical, validateMap};
})();
