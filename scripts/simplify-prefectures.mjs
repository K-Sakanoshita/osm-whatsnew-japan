import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
const tolerance = 0.03;
function simplify(points) {
  if (points.length <= 5) return points;
  const result = [points[0]];
  let previous = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const dx = points[i][0] - previous[0];
    const dy = points[i][1] - previous[1];
    if (dx * dx + dy * dy >= tolerance * tolerance) {
      result.push(points[i]);
      previous = points[i];
    }
  }
  if (result.length < 4) {
    return [points[0], points[Math.floor(points.length / 3)], points[Math.floor(points.length * 2 / 3)], points[0]];
  }
  result.push(result[0]);
  return result;
}

function simplifyGeometry(geometry) {
  if (geometry.type === 'Polygon') {
    geometry.coordinates = geometry.coordinates.map(simplify);
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates = geometry.coordinates.map(polygon => polygon.map(simplify));
  }
}

const geojson = JSON.parse(fs.readFileSync(input, 'utf8'));
geojson.features.forEach(feature => simplifyGeometry(feature.geometry));
fs.writeFileSync(output, JSON.stringify(geojson));
