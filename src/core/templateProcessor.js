const fs = require('fs').promises;
const path = require('path');

const { Octokit } = require('@octokit/rest');
const github = require('@actions/github');

/**
 * Process files with inline version templates
 * @param {Array} files - List of files to process
 * @param {String} version - New version to inject
 * @param {Object} options - Additional options
 * @param {String} options.releaseBranch - Release branch to check for existing content
 * @returns {Array} - List of processed files
 */
async function processVersionFiles(files, version, options = {}) {
  const [major, minor, patch] = version.split('.');
  const processedFiles = [];
  
  console.log(`Starting version file processing for ${files.length} files with version ${version}`);
  console.log(`Parsed version parts: major=${major}, minor=${minor}, patch=${patch}`);
  
  // Set up GitHub client if we're in a GitHub Action
  let octokit = null;
  let context = null;
  let isGitHubAction = false;
  
  try {
    const token = process.env.GITHUB_TOKEN || process.env.INPUT_TOKEN;
    if (token) {
      octokit = github.getOctokit(token);
      context = github.context;
      isGitHubAction = true;
      console.log(`✨ GitHub API client initialized - we'll try to avoid conflicts by checking the release branch first 💅`);
    }
  } catch (e) {
    console.log(`Not running in GitHub Actions or token not available: ${e.message}`);
  }
  
  // Determine which branches to check for existing content
  const releaseBranch = options.releaseBranch || 'release';
  
  for (const file of files) {
    console.log(`\nProcessing version file: ${file}`);
    try {
      // Try to get content from GitHub API first to avoid conflicts
      let content = null;
      let contentSource = 'local';
      
      if (isGitHubAction) {
        try {
          console.log(`Trying to fetch ${file} from ${releaseBranch} branch first to avoid conflicts...`);
          const { owner, repo } = context.repo;
          const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: file,
            ref: releaseBranch
          });
          
          content = Buffer.from(data.content, 'base64').toString('utf8');
          contentSource = `${releaseBranch} branch`;
          console.log(`✨ Successfully retrieved ${file} from ${releaseBranch} branch to avoid conflicts!`);
        } catch (error) {
          console.log(`Couldn't get ${file} from ${releaseBranch} branch: ${error.message}`);
          console.log(`Will use local file instead...`);
        }
      }
      
      // Fall back to local file if we couldn't get it from GitHub
      if (!content) {
        // Verify file exists locally
        try {
          await fs.access(file);
          console.log(`Local file exists!`);
        } catch (err) {
          console.error(`CRITICAL ERROR: File does not exist or cannot be accessed: ${file}`);
          console.error(`Error details: ${err.message}`); 
          continue; // Skip to next file
        }
        
        content = await fs.readFile(file, 'utf8');
        console.log(`File read successfully from local filesystem (${content.length} bytes)`);
      } else {
        console.log(`Using content from ${contentSource} to avoid conflicts 💅`);
      }
      
      console.log(`Looking for version template markers...`);
      console.log(`File content preview (first 200 chars):\n${content.substring(0, 200)}...`);
      
      const lines = content.split('\n');
      const outputLines = [];
      
      // Process line by line
      let i = 0;
      let foundTemplates = 0;
      while (i < lines.length) {
        const line = lines[i];
        const templateStartIndex = line.indexOf('%%release-boss:');
        
        // If this is not a template line, just add it and continue
        if (templateStartIndex === -1) {
          outputLines.push(line);
          i++;
          continue;
        }
        
        // We found a template start marker
        foundTemplates++;
        console.log(`Found template marker #${foundTemplates} at line ${i + 1}:\n    ${line}`);
        
        // First, add the template line itself to preserve it
        outputLines.push(line);
        
        // Determine if it's a single-line or multi-line template
        const startMarkerEnd = templateStartIndex + '%%release-boss:'.length;
        const templateEndInSameLine = line.indexOf('%%', startMarkerEnd);
        
        let templateContent;
        let endLineIndex = i;
        
        if (templateEndInSameLine !== -1) {
          // Single-line template
          templateContent = line.substring(startMarkerEnd, templateEndInSameLine).trim();
        } else {
          // Multi-line template
          const templateLines = [];
          templateLines.push(line.substring(startMarkerEnd).trim());
          
          let j = i + 1;
          let foundEndMarker = false;
          
          // Look for the end marker on subsequent lines
          while (j < lines.length) {
            const currentLine = lines[j];
            
            // Check if the current line contains the end marker
            const endMarkerIndex = currentLine.indexOf('%%');
            if (endMarkerIndex !== -1) {
              // We found the end marker
              templateLines.push(currentLine.substring(0, endMarkerIndex).trim());
              endLineIndex = j;
              foundEndMarker = true;
              
              // Add all template lines to preserve them
              for (let k = i + 1; k <= j; k++) {
                outputLines.push(lines[k]);
              }
              
              break;
            } else {
              templateLines.push(currentLine.trim());
            }
            
            j++;
          }
          
          if (!foundEndMarker) {
            console.warn(`No template end marker found starting at line ${i + 1} in ${file}`);
            i++;
            continue;
          }
          
          templateContent = templateLines.join('\n').trim();
        }
        
        // Jump to the line after the template
        i = endLineIndex + 1;
        
        // Render the template content
        const renderedTemplate = renderTemplate(templateContent, version, major, minor, patch);
        const renderedLines = renderedTemplate.split('\n');
        
        // Count the lines in the current implementation (that will be replaced)
        // Find how many lines to skip (the implementation we're replacing)
        let implementationEndLine = i;
        const implementationLines = [];
        
        while (implementationEndLine < lines.length) {
          // Stop if we find another template marker
          if (lines[implementationEndLine].includes('%%release-boss:')) {
            break;
          }
          
          implementationLines.push(lines[implementationEndLine]);
          implementationEndLine++;
          
          // If we've found enough lines to replace, stop
          if (implementationLines.length >= renderedLines.length) {
            break;
          }
        }
        
        // Skip the lines we're replacing (don't add them to the output)
        i += Math.min(renderedLines.length, implementationLines.length);
        
        // Add the rendered template
        for (const renderedLine of renderedLines) {
          outputLines.push(renderedLine);
        }
      }
      
      // Write the updated content back to the file
      console.log(`\nSaving updated file content to ${file}...`);
      console.log(`Final file stats: ${outputLines.length} lines, ${outputLines.join('\n').length} bytes`);
      
      try {
        await fs.writeFile(file, outputLines.join('\n'), 'utf8');
        console.log(`SUCCESS! Updated version references in ${file}`);
        
        // Verify the file was written correctly
        const verifyContent = await fs.readFile(file, 'utf8');
        console.log(`Verification: File size after save is ${verifyContent.length} bytes`);
        
        // Get the absolute path for reporting
        const absPath = path.resolve(file);
        console.log(`Absolute path for tracking: ${absPath}`);
        
        processedFiles.push(absPath);
        console.log(`Added to processed files list: ${absPath}`);
        console.log(`Current processed files list: ${processedFiles.join(', ')}`);
      } catch (saveError) {
        console.error(`CRITICAL ERROR saving file ${file}: ${saveError.message}`);
        console.error(`File system error details: ${JSON.stringify(saveError)}`);
        throw saveError;
      }
      
    } catch (error) {
      console.error(`Error processing version file ${file}: ${error.message}`);
      console.error(`Stack trace: ${error.stack}`);
      throw error;
    }
  }
  
  return processedFiles;
}

/**
 * Process template files
 * @param {Array} files - List of template files to process
 * @param {String} version - New version to inject
 * @returns {Array} - List of generated output files
 */
async function processTemplateFiles(files, version) {
  const [major, minor, patch] = version.split('.');
  const generatedFiles = [];
  
  console.log(`\nStarting template file processing for ${files.length} files with version ${version}`);
  
  for (const templateFile of files) {
    console.log(`\nProcessing template file: ${templateFile}`);
    try {
      // Verify file exists
      try {
        await fs.access(templateFile);
        console.log(`Template file exists! Time to transform you, honey!`);
      } catch (err) {
        console.error(`CRITICAL ERROR: Template file does not exist or cannot be accessed: ${templateFile}`);
        console.error(`Error details: ${err.message}`);
        continue; // Skip to next file
      }
      
      console.log(`Reading template content...`);
      const content = await fs.readFile(templateFile, 'utf8');
      console.log(`Template read successfully (${content.length} bytes)`);
      console.log(`Template preview:\n${content.substring(0, 200)}...`);
      
      // Determine output file name based on the template file name
      let outputFile = templateFile;
      
      if (templateFile.includes('.tpl')) {
        // Remove '.tpl' from the filename
        outputFile = templateFile.replace(/\.tpl/g, '');
        console.log(`Template has .tpl extension - output file will be: ${outputFile}`);
      } else {
        // Add '.new' to the filename
        const parsedPath = path.parse(templateFile);
        outputFile = path.join(parsedPath.dir, `${parsedPath.name}.new${parsedPath.ext}`);
        console.log(`Template doesn't have .tpl extension - output file will be: ${outputFile}`);
      }
      
      // Get absolute paths for proper tracking
      const absTemplateFile = path.resolve(templateFile);
      const absOutputFile = path.resolve(outputFile);
      
      console.log(`Processing template file: ${absTemplateFile} -> ${absOutputFile}`);
      
      // Render the entire file content by replacing template markers
      console.log(`Rendering template with version ${version}...`);
      const renderedContent = renderTemplate(
        content,
        version,
        major,
        minor,
        patch
      );
      console.log(`Template rendering complete! (${renderedContent.length} bytes)`);
      console.log(`Rendered content preview:\n${renderedContent.substring(0, 200)}...`);
      
      // Write to output file
      console.log(`Saving rendered content to ${absOutputFile}...`);
      try {
        await fs.writeFile(outputFile, renderedContent, 'utf8');
        console.log(`SUCCESS! Processed template file: ${templateFile} -> ${outputFile}`);
        
        // Verify the file was written correctly
        const verifyContent = await fs.readFile(outputFile, 'utf8');
        console.log(`Verification: Output file size is ${verifyContent.length} bytes`);
        
        // Add to the list of generated files (using absolute path)
        generatedFiles.push(absOutputFile);
        console.log(`Added to generated files list: ${absOutputFile}`);
        console.log(`Current generated files list: ${generatedFiles.join(', ')}`);
      } catch (saveError) {
        console.error(`CRITICAL ERROR saving output file ${outputFile}: ${saveError.message}`);
        console.error(`File system error details: ${JSON.stringify(saveError)}`);
        throw saveError;
      }
      
    } catch (error) {
      console.error(`Error processing template file ${templateFile}: ${error.message}`);
      console.error(`Stack trace: ${error.stack}`);
      throw error;
    }
  }
  
  return generatedFiles;
}

/**
 * Render a template with version values
 * @param {String} template - Template content
 * @param {String} version - Full version string (x.y.z)
 * @param {String} major - Major version
 * @param {String} minor - Minor version
 * @param {String} patch - Patch version
 * @returns {String} - Rendered template
 */
function renderTemplate(template, version, major, minor, patch) {
  return template
    .replace(/\{\{version\}\}/g, version)
    .replace(/\{\{major\}\}/g, major)
    .replace(/\{\{minor\}\}/g, minor)
    .replace(/\{\{patch\}\}/g, patch);
}

/**
 * Process files with line-based search and replace
 * @param {Array} files - List of update file configurations
 * @param {String} version - New version to inject
 * @param {Object} options - Additional options
 * @param {String} options.releaseBranch - Release branch to check for existing content
 * @returns {Array} - List of processed files
 */
async function processUpdateFiles(files, version, options = {}) {
  if (!files || !Array.isArray(files) || files.length === 0) {
    console.log('No update files to process');
    return [];
  }

  const [major, minor, patch] = version.split('.');
  const processedFiles = [];
  
  console.log(`Starting update file processing for ${files.length} files with version ${version}`);
  console.log(`Parsed version parts: major=${major}, minor=${minor}, patch=${patch}`);
  
  // Set up GitHub client if we're in a GitHub Action
  let octokit = null;
  let context = null;
  let isGitHubAction = false;
  
  try {
    const token = process.env.GITHUB_TOKEN || process.env.INPUT_TOKEN;
    if (token) {
      octokit = github.getOctokit(token);
      context = github.context;
      isGitHubAction = true;
      console.log(`✨ GitHub API client initialized - we'll try to avoid conflicts by checking the release branch first 💅`);
    }
  } catch (e) {
    console.log(`Not running in GitHub Actions or token not available: ${e.message}`);
  }
  
  // Determine which branches to check for existing content
  const releaseBranch = options.releaseBranch || 'release';
  
  for (const fileConfig of files) {
    if (!fileConfig.file || !fileConfig.findLine || !fileConfig.replaceLine) {
      console.log(`Skipping invalid update file config: ${JSON.stringify(fileConfig)}`);
      continue;
    }
    
    const filePath = fileConfig.file;
    console.log(`\nProcessing update file: ${filePath}`);
    
    try {
      // Try to get content from GitHub API first to avoid conflicts
      let content = null;
      let contentSource = 'local';
      
      if (isGitHubAction) {
        try {
          console.log(`Trying to fetch ${filePath} from ${releaseBranch} branch first to avoid conflicts...`);
          const { data: fileData } = await octokit.rest.repos.getContent({
            owner: context.repo.owner,
            repo: context.repo.repo,
            path: filePath,
            ref: releaseBranch
          });
          
          if (fileData && fileData.content) {
            content = Buffer.from(fileData.content, 'base64').toString('utf8');
            contentSource = 'github';
            console.log(`Successfully fetched content from GitHub API (${releaseBranch} branch) 💅`);
          }
        } catch (error) {
          console.log(`Couldn't fetch from GitHub API: ${error.message}. Will try local file instead.`);
        }
      }
      
      // Fall back to local file if GitHub API didn't work
      if (!content) {
        try {
          content = await fs.readFile(filePath, 'utf8');
          contentSource = 'local';
          console.log(`Read file content from local filesystem`);
        } catch (error) {
          if (error.code === 'ENOENT') {
            console.log(`File doesn't exist locally, will create it`);
            content = '';
          } else {
            throw error;
          }
        }
      }
      
      // Process the file content by searching for the line and replacing it
      const findLine = fileConfig.findLine;
      let replaceLine = fileConfig.replaceLine;
      
      // Render the replacement line with version variables
      replaceLine = renderTemplate(replaceLine, version, major, minor, patch);
      
      console.log(`Searching for line: ${findLine}`);
      console.log(`Replacing with: ${replaceLine}`);
      
      // Split content into lines, find and replace the target line
      const lines = content.split('\n');
      let found = false;
      
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(findLine)) {
          console.log(`Found match on line ${i+1}: ${lines[i]}`);
          lines[i] = replaceLine;
          found = true;
          break;
        }
      }
      
      if (!found) {
        console.log(`Warning: Could not find line containing '${findLine}' in ${filePath}`);
        continue;
      }
      
      // Join the lines back together
      const updatedContent = lines.join('\n');
      
      // Write the updated content back to the file
      await fs.writeFile(filePath, updatedContent, 'utf8');
      console.log(`Updated ${filePath} with new version information 💅`);
      
      processedFiles.push(filePath);
    } catch (error) {
      console.error(`Error processing update file ${filePath}: ${error.message}`);
      throw error;
    }
  }
  
  return processedFiles;
}

module.exports = {
  processVersionFiles,
  processTemplateFiles,
  processUpdateFiles
};
