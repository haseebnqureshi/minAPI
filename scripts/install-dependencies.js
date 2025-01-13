const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function installCoreDependencies() {
  const miniApiDir = path.join(__dirname, '..');
  
  // Check if we're in development mode (running from minapi project directly)
  const isDevelopment = fs.existsSync(path.join(miniApiDir, '.git'));
  if (isDevelopment) {
    console.log('Development mode detected, skipping core dependency installation');
    return;
  }

  console.log('Installing MinAPI core dependencies...');
  
  try {
    // Create node_modules directory if it doesn't exist
    const nodeModulesPath = path.join(miniApiDir, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      fs.mkdirSync(nodeModulesPath, { recursive: true });
    }

    // Install dependencies and allow installation scripts to run
    execSync('npm install', {
      stdio: 'inherit',
      cwd: miniApiDir,
      env: { ...process.env, SKIP_POSTINSTALL: 'true' } // Prevent recursive postinstall
    });
    
    console.log('Core dependencies installed successfully');
  } catch (err) {
    console.error('Failed to install core dependencies:', err);
    throw err;
  }
}

installCoreDependencies(); 