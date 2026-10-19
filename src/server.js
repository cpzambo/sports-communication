const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    // Force a .jpg extension so YOLO recognizes the file type
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, file.fieldname + '-' + uniqueSuffix + '.jpg')
  }
});

const upload = multer({ storage: storage });

const app = express();
app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:3001'],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Serve the 'runs' folder so React can play the output videos
app.use('/output', express.static(path.join(__dirname, 'runs/detect')));

app.post('/run-inference-frame', upload.single('image'), (req, res) => {
    const imagePath = req.file.path; // The temp path of the uploaded frame
    console.log(imagePath)
    const scriptPath = path.join(__dirname, 'test.py');

    // We pass the image path to test.py. 
    // Since test.py uses YOLO().predict/track, it naturally accepts images too.
    const args = [
        'run', 
        '-n', 'sports-communication-annotator', 
        'python',
        scriptPath, 
        imagePath, 
        '--weights', 'best.pt', 
        '--no-track', // Tracking doesn't apply to a single static frame
        '--output', 'runs/detect/current_frame/frame.jpg',
        '--device', 'cpu'
    ];

    let detectionResults = [];
    console.log(`Executing: python ${args.join(' ')}`);
    const pythonProcess = spawn('conda', args);

    pythonProcess.stdout.on('data', (data) => {
        const output = data.toString();
        if (output.includes("DETECTION_DATA:")) {
            const jsonStr = output.split("DETECTION_DATA:")[1];
            detectionResults = JSON.parse(jsonStr);
        }
    });
    pythonProcess.stderr.on('data', (data) => console.error(`Error: ${data}`));

    pythonProcess.on('close', (code) => {
        if (code === 0) {
            // Delete the temp file from uploads/
            fs.unlink(imagePath, (err) => {
                if (err) console.error("Error deleting temp upload:", err);
            });

            const unwantedFolder = path.join(__dirname, 'runs', 'detect', 'current_frame', 'frame'); 
            if (fs.existsSync(unwantedFolder)) {
                fs.rmSync(unwantedFolder, { recursive: true, force: true });
            }

            // For now, we return a success status
            res.status(200).json({
                processedImageUrl: `http://localhost:5001/output/current_frame/frame.jpg`,
                boxes: detectionResults
            });
        } else {
            res.status(500).json({ error: "Inference failed" });
        }
    });
});

app.post('/run-inference', (req, res) => {
    const { videoPath, weights, conf } = req.body;

    // Use the absolute path to your python script
    const scriptPath = path.join(__dirname, 'test.py');
    
    // Construct arguments for test.py
    const args = [
        'run', 
        '-n', 'sports-communication-annotator', 
        'python',
        scriptPath, 
        videoPath, 
        '--weights', weights || 'best.pt', 
        '--conf', conf?.toString() || '0.25',
        '--device', 'cpu'
    ];

    console.log(`Executing: python ${args.join(' ')}`);
    const pythonProcess = spawn('conda', args);

    pythonProcess.stdout.on('data', (data) => console.log(`Python: ${data}`));
    pythonProcess.stderr.on('data', (data) => console.error(`Error: ${data}`));

    pythonProcess.on('close', (code) => {
        if (code === 0) {
            // Logic to find the newest file in runs/detect/predict (or similar)
            // For now, we return a success status
            res.status(200).json({ 
                message: "Inference complete",
                outputFolder: "/output" 
            });
        } else {
            res.status(500).json({ error: "Inference failed" });
        }
    });
});

app.listen(5001, () => console.log('Backend bridge running on http://localhost:5001'));