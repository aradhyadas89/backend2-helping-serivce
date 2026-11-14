import axios from 'axios';

const API_KEY = 'AIzaSyASKhpfg8Ax1V7iTN5ZXx9Lzc2E-lX4_uI';

async function testRoutes() {
  console.log('Testing Google Routes API with Key:', API_KEY.substring(0, 8) + '...');
  try {
    const res = await axios.post(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        origin: {
          location: {
            latLng: {
              latitude: 22.5740,
              longitude: 88.3650,
            },
          },
        },
        destination: {
          location: {
            latLng: {
              latitude: 22.5726,
              longitude: 88.3639,
            },
          },
        },
        travelMode: 'BICYCLE',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': API_KEY,
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
        },
      }
    );
    console.log('Routes API Response:', JSON.stringify(res.data, null, 2));
  } catch (err: any) {
    if (err.response) {
      console.error('Routes API Error Response:', err.response.status, err.response.data);
    } else {
      console.error('Routes Request Failed:', err.message);
    }
  }
}

testRoutes();
