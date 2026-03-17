const { execSync } = require('child_process')
exports.default = async ({ appOutDir }) => {
  console.log('  • stripping extended attributes from', appOutDir)
  execSync(`xattr -cr "${appOutDir}"`, { stdio: 'inherit' })
}
