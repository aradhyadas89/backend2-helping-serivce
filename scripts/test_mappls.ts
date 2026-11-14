import axios from 'axios';

const KEY = 'epdccakxxpiaskznoidkzaqidtjaawiodxbl';

async function testAuthVariations() {
  // Test 1: Bearer token in Authorization header
  try {
    const url = 'https://apis.mappls.com/advancedmaps/v1/distance_matrix/biking/88.3650,22.5740;88.3639,22.5726';
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${KEY}`,
      },
    });
    console.log('Bearer Token Success:', res.data);
  } catch (err: any) {
    console.log('Bearer Token Failed:', err.response?.status, err.response?.data);
  }

  // Test 2: Header with api_key
  try {
    const url = 'https://apis.mappls.com/advancedmaps/v1/distance_matrix/biking/88.3650,22.5740;88.3639,22.5726';
    const res = await axios.get(url, {
      headers: {
        api_key: KEY,
      },
    });
    console.log('api_key Header Success:', res.data);
  } catch (err: any) {
    console.log('api_key Header Failed:', err.response?.status, err.response?.data);
  }

  // Test 3: Atlas endpoint (modern Mappls v1/v2)
  try {
    const url = `https://atlas.mappls.com/api/places/geocode?address=Kolkata`;
    const res = await axios.get(url, {
      headers: {
        Authorization: `bearer ${KEY}`,
      },
    });
    console.log('Atlas Geocode Bearer Success:', res.data);
  } catch (err: any) {
    console.log('Atlas Geocode Bearer Failed:', err.response?.status, err.response?.data);
  }

  // Test 4: Atlas endpoint with query token
  try {
    const url = `https://atlas.mappls.com/api/places/geocode?address=Kolkata&access_token=${KEY}`;
    const res = await axios.get(url);
    console.log('Atlas Geocode Query Token Success:', res.data);
  } catch (err: any) {
    console.log('Atlas Geocode Query Token Failed:', err.response?.status, err.response?.data);
  }
}

testAuthVariations();
