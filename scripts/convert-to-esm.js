import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const srcDir = path.join(__dirname, '../src');

function convertFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;
    
    // Convert require to import
    content = content.replace(
        /const\s+\{([^}]+)\}\s*=\s*require\(['"]([^'"]+)['"]\);/g,
        (match, imports, modulePath) => {
            modified = true;
            return `import {${imports}} from '${modulePath.endsWith('.js') ? modulePath : modulePath + '.js'}';`;
        }
    );
    
    content = content.replace(
        /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);/g,
        (match, varName, modulePath) => {
            modified = true;
            return `import ${varName} from '${modulePath.endsWith('.js') ? modulePath : modulePath + '.js'}';`;
        }
    );
    
    // Convert module.exports to export default
    content = content.replace(/module\.exports\s*=\s*/g, 'export default ');
    
    // Convert exports.name to named exports
    content = content.replace(/exports\.(\w+)\s*=/g, 'export const $1 =');
    
    if (modified) {
        fs.writeFileSync(filePath, content);
        console.log(`✓ Converted: ${filePath}`);
    }
}

function walkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            walkDir(filePath);
        } else if (file.endsWith('.js')) {
            convertFile(filePath);
        }
    }
}

walkDir(srcDir);
console.log('Conversion complete!');
