const yaml = require('js-yaml');
const s = 'Authorization: Bearer sk-1234';
try {
  const obj = yaml.load(s);
  console.log('Parsed:', JSON.stringify(obj));
  console.log('Keys:', Object.keys(obj));
  console.log('Value:', obj['Authorization']);
} catch (e) {
  console.error('Error:', e.message);
}