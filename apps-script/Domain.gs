/** Pure data rules. No Google services; exercised by node --test. */
const RealmData = (() => {
  const masterHeader = ['World', 'Location', 'X', 'Z', 'Type', 'Owner'];
  const mapHeader = ['Origin/Destination', 'Path', 'Location', 'X', 'Z', 'Type', 'Owner'];
  const claimHeader = ['shapeId', 'shapeType', 'shapeLabel', 'pointId', 'X', 'Z', 'Type', 'Owner'];
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

  function matches(value, name) { return text(value).toLowerCase() === name.toLowerCase(); }
  function copySource(source) {
    return {
      master: source.master.map(row => row.slice()),
      maps: Object.fromEntries(Object.entries(source.maps).map(([world, rows]) => [world, rows.map(row => row.slice())])),
      claims: source.claims.map(row => row.slice()),
    };
  }

  // Plans contain only data. The service verifies the preview and writes in place.
  function planEdit(source, input) {
    const data = model(source.master, source.maps);
    const next = copySource(source);
    const summary = [];
    let destructive = false;
    if (input.action === 'location' || input.action === 'delete-location') {
      const previous = data.places.get(key({world: input.world, name: field(input.originalName, 'Original location')}));
      if (!previous) throw new Error('Location no longer exists. Reload the sidebar.');
      const network = data.networks[previous.world];
      const connected = [...network.paths].filter(([, rows]) => rows.some(row => matches(row[2], previous.name)));
      table(source.claims, claimHeader, 'Land Claim Data');
      const claimRows = previous.world === 'Overworld'
        ? source.claims.slice(1).filter(row => matches(row[2], previous.name)) : [];
      if (input.action === 'delete-location') {
        if (connected.length) throw new Error('Remove this location’s ' + connected.length + ' connection(s) first. No connected locations are deleted.');
        if (claimRows.length) throw new Error('This place has a land-claim polygon. Resolve that claim in the Sheet before removing the place.');
        next.master = next.master.filter((row, index) => !index || text(row[0]) !== previous.world || !matches(row[1], previous.name));
        next.maps[previous.world] = next.maps[previous.world].filter((row, index) => !index || !matches(row[2], previous.name));
        summary.push('Remove ' + previous.name + ' from Master Locations and ' + worlds[previous.world] + '.');
        destructive = true;
      } else {
        const place = location([input.newWorld ?? previous.world, input.name, input.x, input.z, input.type, input.owner]);
        const moved = place.world !== previous.world;
        if (moved && connected.length) throw new Error('Remove this location’s connections before moving it to another world.');
        if (moved && claimRows.length) throw new Error('This place has an Overworld land-claim polygon. Resolve that claim in the Sheet before moving the place.');
        if (key(place) !== key(previous) && data.places.has(key(place))) throw new Error('Another location in this world already has that name.');
        if (place.world === 'Overworld' && (moved || !matches(place.name, previous.name))
            && source.claims.slice(1).some(row => matches(row[2], place.name))) {
          throw new Error('Another land claim already uses the new location name. Resolve it in the Sheet first.');
        }
        if (connected.length && place.name.includes(',')) throw new Error('Connected location names cannot contain commas (Tableau filter delimiter).');
        for (const [fieldName, label] of [['world', 'World'], ['name', 'Name'], ['owner', 'Owner'], ['type', 'Type'], ['x', 'X'], ['z', 'Z']]) {
          if (previous[fieldName] !== place[fieldName]) summary.push(label + ': ' + (previous[fieldName] === '' ? '(blank)' : previous[fieldName]) + ' → ' + (place[fieldName] === '' ? '(blank)' : place[fieldName]));
        }
        next.master = next.master.map((row, index) => index && text(row[0]) === previous.world && matches(row[1], previous.name)
          ? [place.world, place.name, place.x, place.z, place.type, place.owner] : row);
        if (moved) {
          next.maps[previous.world] = next.maps[previous.world].filter((row, index) => !index || !matches(row[2], previous.name));
          if (network.places.has(key(previous))) next.maps[place.world].push(mapRow(place));
        } else {
          next.maps[previous.world] = next.maps[previous.world].map((row, index) => index && matches(row[2], previous.name)
            ? [row[0], row[1], place.name, place.x, place.z, place.type, place.owner] : row);
        }
        const claimChanges = [['name', 2], ['type', 6], ['owner', 7]].filter(([name]) => previous[name] !== place[name]);
        if (claimRows.length && claimChanges.length) {
          for (const [name, column] of claimChanges) {
            if (name !== 'name' && claimRows.some(row => text(row[column]) !== previous[name])) {
              throw new Error('The matching land claim has a different ' + name + '. Resolve that mismatch in the Sheet first.');
            }
          }
          next.claims = next.claims.map((row, index) => {
            if (!index || !matches(row[2], previous.name)) return row;
            const updated = row.slice();
            for (const [name, column] of claimChanges) updated[column] = place[name];
            return updated;
          });
          summary.push('Update matching land-claim labels/details (' + claimRows.length + ' polygon rows). Boundaries stay unchanged.');
        }
        if (summary.length) summary.push('Update every copy in this world. Existing Path IDs stay unchanged.');
      }
    } else if (input.action === 'rails') {
      if (input.world !== 'Overworld') throw new Error('This editor changes Overworld rail connections only.');
      const sourcePlace = data.places.get(key({world: 'Overworld', name: field(input.source, 'Source')}));
      if (!sourcePlace) throw new Error('Source location no longer exists. Reload the sidebar.');
      const additions = planConnections(source.master, source.maps, input);
      const desired = new Set(input.destinations.map(name => key({world: 'Overworld', name: field(name, 'Destination')})));
      const removed = [...data.networks.Overworld.paths].filter(([, rows]) =>
        rows.some(row => row[2] === sourcePlace.name) && rows.some(row => row[2] !== sourcePlace.name && !desired.has(key({world: 'Overworld', name: row[2]}))));
      const removedIds = new Set(removed.map(([name]) => name));
      // Keep a standalone point only when no surviving/new row represents it.
      // Repeated remove/add cycles must not accumulate duplicate point rows.
      const retained = new Set([...next.maps.Overworld.slice(1).filter(row => !removedIds.has(row[1])), ...additions.rows]
        .map(row => text(row[2]).toLowerCase()));
      next.maps.Overworld = next.maps.Overworld.flatMap((row, index) => {
        if (!index || !removedIds.has(row[1])) return [row];
        const id = text(row[2]).toLowerCase();
        if (retained.has(id)) return [];
        retained.add(id);
        return [['Origin', '', ...row.slice(2)]];
      }).concat(additions.rows);
      for (const [name, rows] of removed) summary.push('Remove: ' + rows[0][2] + ' ↔ ' + rows[1][2] + ' (Path: ' + name + ')');
      for (const name of additions.added) summary.push('Add: ' + name);
      if (removed.length) summary.push('Endpoint locations stay on the map. Both directions of each removed rail link are removed.');
      destructive = removed.length > 0;
    } else throw new Error('Unknown edit action.');
    model(next.master, next.maps);
    return {next, summary, destructive};
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

  return {masterHeader, mapHeader, claimHeader, worlds, model, planLocation, planConnections, planEdit, canonical, validateMap};
})();
